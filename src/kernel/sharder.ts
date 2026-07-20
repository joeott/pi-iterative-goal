/**
 * Post-plan sharder (deployment plan Ch. 6 §6.1–6.3, Campaign 2).
 *
 * Pipeline: typed plan (PlanSpecSchema, posted via goal_post_shards) →
 * dependency graph (vertices = allowlist files, edges = static import
 * references, symmetrized) → balanced minimum-cut partition (spectral
 * bisection on the Fiedler vector as PRIOR + Kernighan–Lin swap refinement)
 * → coupling-density shardability gate → ShardPlan record. The record is
 * committed by the lifecycle hook as a `shard_posted` event; C3's scheduler
 * consumes it. Nothing here dispatches or schedules work.
 *
 * The Fiedler eigenproblem is solved with classical (max-pivot) Jacobi
 * rotations for small symmetric matrices — no new dependencies are
 * introduced. The rotation budget is 12 sweep-equivalents (one sweep =
 * n(n−1)/2 rotations) with early termination at a 1e-12 off-diagonal
 * residual; convergence across the operating range (≤ MAX_SHARD_VERTICES
 * vertices) is gated by a closed-form path-graph fixture in the smoke
 * suite (C2-ADV-001). The import scanner is regex-based over comment- and
 * string-masked source; residual v1 limits (no tsconfig path aliases,
 * template literals treated as opaque) are documented trade-offs
 * (C2-ADV-008).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanSpec } from "../domain/plan.js";
import {
  normalizeRepoPath,
  pathMatchesScope,
  resolveContainedPath,
  type PathScope,
} from "../domain/path-scope.js";
import { readIterativeGoalSettings } from "../domain/project-settings.js";
import type { Shard, ShardPlan } from "../domain/shard.js";
import { pathsOverlap } from "../agents/pool.js";
import { logDebug } from "../logging.js";
import type { StateManagerAPI } from "../state.js";

function log(msg: string) {
  logDebug("sharder", msg);
}

// ── Feature flag + tuning (.pi/settings.json → iterativeGoal.sharder) ──

export interface SharderConfig {
  /** Sharder hook is disabled by default (campaign lands flag-off, §8.5). */
  enabled: boolean;
  /** Imbalance-fraction tolerance ε (§6.3 default 0.34 → at most a 2:1 size ratio). */
  balanceTolerance: number;
  /** Fan-out is declined when cutWeight/totalEdgeWeight meets or exceeds this fraction. */
  maxCouplingDensity: number;
  /** Shard-count cap for recursive bisection (v1 default 2 = single bisection). */
  maxShards: number;
}

export const DEFAULT_BALANCE_TOLERANCE = 0.34;
// Uncalibrated v1 default (C2-OUS-008): chosen absent telemetry; revisit
// once C3's measured shard outcomes provide a calibration corpus.
export const DEFAULT_MAX_COUPLING_DENSITY = 0.5;
export const DEFAULT_MAX_SHARDS = 2;
/**
 * Hard vertex budget (C2-ADV-002): the eigensolver runs synchronously
 * inside agent_end, so fan-out is declined beyond this graph size rather
 * than freezing the host on a `src/**`-scale allowlist.
 */
export const MAX_SHARD_VERTICES = 200;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(num, max));
}

export function loadSharderConfig(cwd: string): SharderConfig {
  // Shared guarded reader (src/domain/project-settings.ts, C2-OUS-003).
  const sharder = readIterativeGoalSettings(cwd).sharder;
  const config = sharder && typeof sharder === "object" ? sharder as Record<string, unknown> : {};
  return {
    enabled: config.enabled === true,
    balanceTolerance: clampNumber(config.balanceTolerance, DEFAULT_BALANCE_TOLERANCE, 0.01, 0.5),
    maxCouplingDensity: clampNumber(config.maxCouplingDensity, DEFAULT_MAX_COUPLING_DENSITY, 0.01, 1),
    maxShards: Math.floor(clampNumber(config.maxShards, DEFAULT_MAX_SHARDS, 2, 8)),
  };
}

// ── Dependency graph construction (§6.2) ─────────────────────────────

export interface ImportReference {
  from: string;
  to: string;
  weight: number;
}

export interface DependencyGraph {
  /** Normalized repo-relative paths, sorted — index i is the matrix row/col. */
  vertices: string[];
  /** Symmetrized edges with i < j; weight = reference count in both directions (§6.2). */
  edges: Array<{ i: number; j: number; weight: number }>;
  totalWeight: number;
}

const IMPORT_SPECIFIER_PATTERNS = [
  /\bimport[\s\S]{0,500}?\sfrom\s*["']([^"']+)["']/g,
  /\bexport[\s\S]{0,500}?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json"];

/**
 * Masks comments and string/template literals so import patterns only match
 * real code (C2-ADV-008): comment text is blanked in the returned source
 * (newlines preserved), and masked[i] is true inside string/template
 * literals, so a match starting there is string content, not an import.
 * Residual v1 limits: template literals are opaque (nested `${}` templates
 * can leak state), and regex literals are not lexed — a quote inside a
 * regex can over-mask. Both are documented trade-offs for a regex scanner.
 */
function maskCommentsAndStrings(source: string): { code: string; masked: boolean[] } {
  const chars = source.split("");
  const masked = new Array<boolean>(source.length).fill(false);
  const blank = (index: number) => {
    if (chars[index] !== "\n") chars[index] = " ";
  };
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const next = chars[i + 1];
    switch (state) {
      case "code":
        if (ch === "/" && next === "/") {
          blank(i);
          blank(i + 1);
          i += 1;
          state = "line";
        } else if (ch === "/" && next === "*") {
          blank(i);
          blank(i + 1);
          i += 1;
          state = "block";
        } else if (ch === "'") {
          masked[i] = true;
          state = "single";
        } else if (ch === '"') {
          masked[i] = true;
          state = "double";
        } else if (ch === "`") {
          masked[i] = true;
          state = "template";
        }
        break;
      case "line":
        blank(i);
        if (ch === "\n") state = "code";
        break;
      case "block":
        blank(i);
        if (ch === "*" && next === "/") {
          blank(i + 1);
          i += 1;
          state = "code";
        }
        break;
      default: {
        // single / double / template literal interiors.
        masked[i] = true;
        const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
        if (ch === "\\" && i + 1 < chars.length) {
          masked[i + 1] = true;
          i += 1;
        } else if (ch === quote) {
          state = "code";
        }
        break;
      }
    }
  }
  return { code: chars.join(""), masked };
}

/**
 * v1 edge resolution: static import/require specifiers, resolved against the
 * vertex set. Only relative specifiers (./ ../) map to plan files — package
 * imports never couple two allowlist files. Reads go through
 * resolveContainedPath (the same containment the repo-context capability
 * uses). Comments and string contents are masked before matching, and
 * references are deduped by (from, to, specifier) so overlapping patterns
 * cannot double-count: edge weight = distinct-specifier count (§6.2).
 */
export function resolveStaticImportReferences(vertices: string[], repoRoot: string): ImportReference[] {
  const vertexSet = new Set(vertices);
  const references: ImportReference[] = [];
  const seen = new Set<string>();
  for (const vertex of vertices) {
    let source: string;
    try {
      source = fs.readFileSync(resolveContainedPath(repoRoot, vertex), "utf8");
    } catch {
      continue; // Missing/unreadable files contribute no edges (a plan may name files being created).
    }
    const { code, masked } = maskCommentsAndStrings(source);
    for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of code.matchAll(pattern)) {
        if (masked[match.index]) continue; // String/comment content, not an import statement.
        const specifier = match[1];
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(vertex), specifier));
        const candidates = [
          base,
          ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
          ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
        ];
        const target = candidates.find((candidate) => vertexSet.has(candidate));
        if (!target || target === vertex) continue;
        const key = `${vertex} ${target} ${specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({ from: vertex, to: target, weight: 1 });
      }
    }
  }
  return references;
}

/** Builds G = (V, E, w), symmetrized: an import in either direction signals coupling (§6.2). */
export function buildDependencyGraph(
  vertices: string[],
  options: {
    repoRoot?: string;
    resolveReferences?: (vertices: string[]) => ImportReference[];
  } = {},
): DependencyGraph {
  const sorted = [...new Set(vertices)].sort();
  const resolveReferences = options.resolveReferences
    ?? ((vs: string[]) => resolveStaticImportReferences(vs, options.repoRoot ?? process.cwd()));
  const indexOf = new Map(sorted.map((vertex, index) => [vertex, index]));
  const weights = new Map<string, { i: number; j: number; weight: number }>();
  for (const reference of resolveReferences(sorted)) {
    const i = indexOf.get(reference.from);
    const j = indexOf.get(reference.to);
    if (i === undefined || j === undefined || i === j) continue;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = `${lo}|${hi}`;
    const edge = weights.get(key) ?? { i: lo, j: hi, weight: 0 };
    edge.weight += reference.weight;
    weights.set(key, edge);
  }
  const edges = [...weights.values()].sort((a, b) => a.i - b.i || a.j - b.j);
  return {
    vertices: sorted,
    edges,
    totalWeight: edges.reduce((sum, edge) => sum + edge.weight, 0),
  };
}

/** Expands task allowedPaths into the vertex set; glob scopes expand against the repo listing. */
export function planAllowlistFiles(
  plan: PlanSpec,
  options: { listFiles?: () => string[] } = {},
): { vertices: string[]; filesByTaskId: Map<string, string[]> } {
  const vertices = new Set<string>();
  const filesByTaskId = new Map<string, string[]>();
  let repoFiles: string[] | null = null;
  for (const task of plan.tasks) {
    const taskFiles = new Set<string>();
    for (const scope of task.allowedPaths) {
      if (scope.kind === "exact") {
        try {
          const file = normalizeRepoPath(scope.path);
          vertices.add(file);
          taskFiles.add(file);
        } catch {
          log(`Skipping un-normalizable allowlist path '${scope.path}' in task ${task.id}`);
        }
        continue;
      }
      // Glob scopes name a file SET; vertices are concrete files, so expand.
      if (repoFiles === null) repoFiles = options.listFiles ? options.listFiles() : [];
      for (const file of repoFiles) {
        try {
          if (!pathMatchesScope(file, scope)) continue;
          vertices.add(file);
          taskFiles.add(file);
        } catch {
          continue;
        }
      }
    }
    filesByTaskId.set(task.id, [...taskFiles].sort());
  }
  return { vertices: [...vertices].sort(), filesByTaskId };
}

/**
 * Bounded repo walk for glob expansion. SYNC REQUIREMENT (C2-OUS-007): the
 * ignore set mirrors collectFiles in src/repo-context.ts — change one,
 * change both.
 */
export function listRepoFiles(repoRoot: string, maxFiles = 5_000): string[] {
  const ignoredDirs = new Set([".git", "node_modules", "dist", ".pi"]);
  const files: string[] = [];
  function walk(current: string): void {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) walk(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(repoRoot, absolute).replace(/\\/g, "/"));
      }
    }
  }
  walk(repoRoot);
  return files.sort();
}

// ── Spectral prior (§6.3 stage 1) ────────────────────────────────────

/**
 * Classical (max-pivot) Jacobi eigenvalue iteration for small symmetric
 * matrices: each rotation annihilates the largest remaining off-diagonal
 * element. Chosen because it is dependency-free, deterministic (fixed pivot
 * scan order), and converges to a 1e-12 residual within the 12-sweep budget
 * across the sharder's operating range — inverse iteration would need a
 * linear solver and shift policy; Jacobi is ~45 lines with neither.
 *
 * Budget accounting (C2-ADV-001): one SWEEP = n(n−1)/2 rotations. An earlier
 * revision counted rotations against a max(50, 20n) cap and silently
 * under-converged from n≈20; the budget below is in true sweep-equivalents.
 */
export function jacobiEigen(matrix: number[][]): { values: number[]; vectors: number[][] } {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const rotationsPerSweep = Math.max(1, (n * (n - 1)) / 2);
  const maxRotations = 12 * rotationsPerSweep;
  for (let rotation = 0; rotation < maxRotations; rotation += 1) {
    let p = -1;
    let q = -1;
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const value = Math.abs(a[i][j]);
        if (value > max) {
          max = value;
          p = i;
          q = j;
        }
      }
    }
    if (p < 0 || max < 1e-12) break;
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const theta = (aqq - app) / (2 * apq);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    for (let k = 0; k < n; k += 1) {
      if (k === p || k === q) continue;
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[p][k] = a[k][p];
      a[k][q] = s * akp + c * akq;
      a[q][k] = a[k][q];
    }
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = 0;
    a[q][p] = 0;
    for (let k = 0; k < n; k += 1) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i][i]), vectors: v };
}

export function adjacencyMatrix(graph: DependencyGraph): number[][] {
  const n = graph.vertices.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const edge of graph.edges) {
    matrix[edge.i][edge.j] = edge.weight;
    matrix[edge.j][edge.i] = edge.weight;
  }
  return matrix;
}

/**
 * The Fiedler vector: eigenvector of the graph Laplacian L = D − A belonging
 * to the second-smallest eigenvalue λ2 (§6.3). The overall sign is an
 * arbitrary eigensolver choice — bisection by sign is invariant under it.
 */
export function fiedlerVector(adjacency: number[][]): { lambda2: number; vector: number[] } {
  const n = adjacency.length;
  if (n < 2) throw new Error("Fiedler vector requires at least two vertices");
  const degrees = adjacency.map((row) => row.reduce((sum, weight) => sum + weight, 0));
  const laplacian: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? degrees[i] : 0) - adjacency[i][j]));
  const { values, vectors } = jacobiEigen(laplacian);
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => values[a] - values[b] || a - b);
  const fiedlerIndex = order[1];
  return {
    lambda2: values[fiedlerIndex],
    vector: vectors.map((row) => row[fiedlerIndex]),
  };
}

// ── Balanced bisection: spectral prior + KL refinement (§6.3) ────────

function imbalanceFraction(assignment: number[]): number {
  const inB = assignment.reduce((sum, side) => sum + side, 0);
  return Math.abs(assignment.length - 2 * inB) / assignment.length;
}

export function cutWeight(graph: DependencyGraph, assignment: number[]): number {
  let weight = 0;
  for (const edge of graph.edges) {
    if (assignment[edge.i] !== assignment[edge.j]) weight += edge.weight;
  }
  return weight;
}

export interface RefinementReport {
  assignment: number[];
  passes: number;
  evaluatedSwaps: number;
  swapsExecuted: number;
  improved: boolean;
  initialCutWeight: number;
  finalCutWeight: number;
}

/**
 * Kernighan–Lin-style local refinement (§6.3 stage 2). Each pass computes
 * D(v) = external(v) − internal(v), evaluates every cross-shard swap
 * g(a, b) = D(a) + D(b) − 2c(a, b), executes the best positive-gain swap,
 * and stops when no improving swap exists. Swaps preserve block sizes, so
 * the balance invariant ε is structurally untouched (guarded anyway).
 */
export function refineBisection(
  graph: DependencyGraph,
  assignment: number[],
  balanceTolerance: number,
): RefinementReport {
  const n = graph.vertices.length;
  const weights = adjacencyMatrix(graph);
  const current = assignment.slice();
  const initialCutWeight = cutWeight(graph, current);
  let passes = 0;
  let evaluatedSwaps = 0;
  let swapsExecuted = 0;
  const maxSwaps = Math.max(4, 4 * n); // Safety bound; KL converges long before this on small graphs.

  while (swapsExecuted < maxSwaps) {
    passes += 1;
    const gains = Array.from({ length: n }, (_, vertex) => {
      let external = 0;
      let internal = 0;
      for (let other = 0; other < n; other += 1) {
        const weight = weights[vertex][other];
        if (weight === 0) continue;
        if (current[other] === current[vertex]) internal += weight;
        else external += weight;
      }
      return external - internal;
    });

    let best: { a: number; b: number; gain: number } | null = null;
    for (let a = 0; a < n; a += 1) {
      if (current[a] !== 0) continue;
      for (let b = 0; b < n; b += 1) {
        if (current[b] !== 1) continue;
        evaluatedSwaps += 1;
        const gain = gains[a] + gains[b] - 2 * weights[a][b];
        if (gain > 1e-12 && (!best || gain > best.gain + 1e-12)) best = { a, b, gain };
      }
    }
    if (!best) break;

    current[best.a] = 1;
    current[best.b] = 0;
    if (imbalanceFraction(current) > balanceTolerance + 1e-9) {
      // Unreachable (swaps preserve sizes); kept per §6.3's "keeps imbalance within ε".
      current[best.a] = 0;
      current[best.b] = 1;
      break;
    }
    swapsExecuted += 1;
  }

  const finalCutWeight = cutWeight(graph, current);
  return {
    assignment: current,
    passes,
    evaluatedSwaps,
    swapsExecuted,
    improved: swapsExecuted > 0 && finalCutWeight < initialCutWeight - 1e-12,
    initialCutWeight,
    finalCutWeight,
  };
}

export interface BisectionResult {
  assignment: number[];
  priorSplit: "sign" | "median";
  refinement: RefinementReport;
}

/**
 * Spectral bisection prior (§6.3 stage 1): sign split on the Fiedler vector
 * (≥ 0 → block A, < 0 → block B), with a median split substituted when the
 * sign split violates balance tolerance ε. KL refinement then runs always —
 * the prior is a hint, refinement is the discipline.
 */
export function bisectGraph(graph: DependencyGraph, balanceTolerance: number): BisectionResult {
  const { vector } = fiedlerVector(adjacencyMatrix(graph));
  const n = graph.vertices.length;
  let assignment: number[] = vector.map((value) => (value >= 0 ? 0 : 1));
  let priorSplit: "sign" | "median" = "sign";
  if (imbalanceFraction(assignment) > balanceTolerance + 1e-12) {
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => vector[a] - vector[b] || a - b);
    assignment = new Array<number>(n).fill(0);
    for (let rank = 0; rank < order.length; rank += 1) {
      if (rank < Math.ceil(n / 2)) assignment[order[rank]] = 1;
    }
    priorSplit = "median";
  }
  const refinement = refineBisection(graph, assignment, balanceTolerance);
  return { assignment: refinement.assignment, priorSplit, refinement };
}

export interface PartitionResult {
  /** Vertex indices per block. */
  blocks: number[][];
  bisections: number;
  priorSplit: "sign" | "median";
  refinement: { passes: number; evaluatedSwaps: number; swapsExecuted: number; improved: boolean };
  initialCutWeight: number;
}

function inducedSubgraph(graph: DependencyGraph, block: number[]): DependencyGraph {
  const subIndex = new Map(block.map((vertexIndex, index) => [vertexIndex, index]));
  const edges = graph.edges
    .filter((edge) => subIndex.has(edge.i) && subIndex.has(edge.j))
    .map((edge) => ({ i: subIndex.get(edge.i)!, j: subIndex.get(edge.j)!, weight: edge.weight }));
  return {
    vertices: block.map((vertexIndex) => graph.vertices[vertexIndex]),
    edges,
    totalWeight: edges.reduce((sum, edge) => sum + edge.weight, 0),
  };
}

/** k-way partitioning by recursive bisection of the largest block (§6.3). */
export function partitionGraph(
  graph: DependencyGraph,
  options: { maxShards: number; balanceTolerance: number },
): PartitionResult {
  const n = graph.vertices.length;
  let blocks: number[][] = [Array.from({ length: n }, (_, i) => i)];
  let bisections = 0;
  let priorSplit: "sign" | "median" = "sign";
  let initialCutWeight = 0;
  const refinement = { passes: 0, evaluatedSwaps: 0, swapsExecuted: 0, improved: false };

  while (blocks.length < options.maxShards) {
    let candidate = -1;
    for (const [index, block] of blocks.entries()) {
      if (block.length >= 2 && (candidate < 0 || block.length > blocks[candidate].length)) candidate = index;
    }
    if (candidate < 0) break;
    const block = blocks[candidate];
    const subgraph = inducedSubgraph(graph, block);
    const bisection = bisectGraph(subgraph, options.balanceTolerance);
    if (bisections === 0) {
      priorSplit = bisection.priorSplit;
      initialCutWeight = bisection.refinement.initialCutWeight;
    }
    refinement.passes += bisection.refinement.passes;
    refinement.evaluatedSwaps += bisection.refinement.evaluatedSwaps;
    refinement.swapsExecuted += bisection.refinement.swapsExecuted;
    refinement.improved = refinement.improved || bisection.refinement.improved;
    const sideA = block.filter((_, index) => bisection.assignment[index] === 0);
    const sideB = block.filter((_, index) => bisection.assignment[index] === 1);
    blocks = [...blocks.slice(0, candidate), sideA, sideB, ...blocks.slice(candidate + 1)];
    bisections += 1;
  }

  return { blocks, bisections, priorSplit, refinement, initialCutWeight };
}

// ── Shard plan assembly + coupling-density gate (§6.1/§6.3) ──────────

export interface BuildShardPlanOptions {
  runId: string;
  cycle: number;
  cwd: string;
  config?: SharderConfig;
  postedAt?: string;
  resolveReferences?: (vertices: string[]) => ImportReference[];
  listFiles?: () => string[];
}

function emptyShardPlan(
  plan: PlanSpec,
  options: BuildShardPlanOptions,
  config: SharderConfig,
  decisionReason: string,
): ShardPlan {
  return {
    ...plan,
    runId: options.runId,
    cycle: options.cycle,
    shards: [],
    cutWeight: 0,
    totalEdgeWeight: 0,
    couplingDensity: 0,
    balanceTolerance: config.balanceTolerance,
    decision: "single_slice",
    decisionReason,
    algorithm: {
      prior: "spectral-fiedler",
      priorSplit: "sign",
      refinement: "kernighan-lin",
      bisections: 0,
      refinementPasses: 0,
      refinementEvaluatedSwaps: 0,
      refinementSwapsExecuted: 0,
      refinementImproved: false,
      initialCutWeight: 0,
    },
    postedAt: options.postedAt ?? new Date().toISOString(),
  };
}

export function buildShardPlan(plan: PlanSpec, options: BuildShardPlanOptions): ShardPlan {
  const config = options.config ?? loadSharderConfig(options.cwd);
  const postedAt = options.postedAt ?? new Date().toISOString();
  const { vertices, filesByTaskId } = planAllowlistFiles(plan, {
    listFiles: options.listFiles ?? (() => listRepoFiles(options.cwd)),
  });

  // Task-level dependsOn feeds the C3 scheduler, not this graph (§6.2): the
  // graph captures code coupling, not task order.
  if (vertices.length < 2) {
    return emptyShardPlan(plan, options, config,
      `plan allowlists name ${vertices.length} file(s); need at least 2 to partition — implement stays single-slice`);
  }

  // Vertex cap (C2-ADV-002): the eigensolver runs synchronously inside
  // agent_end; a `src/**`-scale allowlist must decline, not freeze the host.
  if (vertices.length > MAX_SHARD_VERTICES) {
    return emptyShardPlan(plan, options, config,
      `vertex_cap_exceeded: ${vertices.length} allowlist files exceed the ${MAX_SHARD_VERTICES}-vertex budget of the synchronous eigensolver — fan-out declined`);
  }

  const graph = buildDependencyGraph(vertices, {
    repoRoot: options.cwd,
    resolveReferences: options.resolveReferences,
  });
  const maxShards = Math.min(config.maxShards, graph.vertices.length);
  const partition = partitionGraph(graph, { maxShards, balanceTolerance: config.balanceTolerance });

  const assignment: number[] = new Array<number>(graph.vertices.length).fill(0);
  partition.blocks.forEach((block, blockIndex) => {
    for (const vertexIndex of block) assignment[vertexIndex] = blockIndex;
  });
  const finalCutWeight = cutWeight(graph, assignment);
  const couplingDensity = graph.totalWeight === 0 ? 0 : finalCutWeight / graph.totalWeight;

  const base = {
    ...plan,
    runId: options.runId,
    cycle: options.cycle,
    cutWeight: finalCutWeight,
    totalEdgeWeight: graph.totalWeight,
    couplingDensity,
    balanceTolerance: config.balanceTolerance,
    algorithm: {
      prior: "spectral-fiedler" as const,
      priorSplit: partition.priorSplit,
      refinement: "kernighan-lin" as const,
      bisections: partition.bisections,
      refinementPasses: partition.refinement.passes,
      refinementEvaluatedSwaps: partition.refinement.evaluatedSwaps,
      refinementSwapsExecuted: partition.refinement.swapsExecuted,
      refinementImproved: partition.refinement.improved,
      initialCutWeight: partition.initialCutWeight,
    },
    postedAt,
  };

  if (partition.blocks.length < 2) {
    return {
      ...base,
      shards: [],
      decision: "single_slice",
      decisionReason: "graph could not be bisected into balanced blocks — implement stays single-slice",
    };
  }

  // Coupling-density shardability gate (§6.1): if the cheapest balanced cut
  // severs a large fraction of all edges, the work is tightly coupled and
  // fan-out is declined — the implement phase keeps its single-slice path.
  if (couplingDensity >= config.maxCouplingDensity) {
    return {
      ...base,
      shards: [],
      decision: "single_slice",
      decisionReason: `coupling density ${couplingDensity.toFixed(3)} ≥ ${config.maxCouplingDensity} threshold (cut weight ${finalCutWeight} of ${graph.totalWeight} total) — work is tightly coupled, fan-out declined`,
    };
  }

  const cutEdges = graph.edges.filter((edge) => assignment[edge.i] !== assignment[edge.j]);
  const shards: Shard[] = partition.blocks.map((block, blockIndex) => {
    const files = new Set(block.map((vertexIndex) => graph.vertices[vertexIndex]));
    const tasks = plan.tasks.filter((task) =>
      (filesByTaskId.get(task.id) ?? []).some((file) => files.has(file)));
    // Write scopes are the shard's exact file set (C2-ADV-004): a task's
    // allowlist can straddle the cut, and carrying it into both shards would
    // hand C3 overlapping writer scopes. Exact-file scopes are disjoint by
    // construction; the pairwise assertion below guards that anyway.
    const shardFiles = [...files].sort();
    const allowedPaths: PathScope[] = shardFiles.map((file) => ({ kind: "exact", path: file }));
    return {
      id: `shard-${blockIndex + 1}`,
      index: blockIndex,
      files: shardFiles,
      taskIds: tasks.map((task) => task.id),
      allowedPaths,
      crossShardContracts: cutEdges
        .filter((edge) => files.has(graph.vertices[edge.i]) || files.has(graph.vertices[edge.j]))
        .map((edge) => files.has(graph.vertices[edge.i])
          ? { from: graph.vertices[edge.i], to: graph.vertices[edge.j], weight: edge.weight }
          : { from: graph.vertices[edge.j], to: graph.vertices[edge.i], weight: edge.weight }),
    };
  });

  // Pairwise write-scope disjointness assertion (C2-ADV-004): never emit a
  // fan_out decision whose shard scopes overlap (C1's writer-allowlist
  // invariant). Exact file sets from one partition cannot overlap, so a hit
  // here means a bug — decline loudly instead of ledgering unsafe scopes.
  const scopeStrings = shards.map((shard) =>
    shard.allowedPaths.map((scope) => (scope.kind === "exact" ? scope.path : scope.pattern)));
  for (let i = 0; i < shards.length; i += 1) {
    for (let j = i + 1; j < shards.length; j += 1) {
      if (pathsOverlap(scopeStrings[i], scopeStrings[j])) {
        return {
          ...base,
          shards: [],
          decision: "single_slice",
          decisionReason: `shard_scope_overlap: ${shards[i].id} and ${shards[j].id} would share write scope — fan-out declined`,
        };
      }
    }
  }

  return {
    ...base,
    shards,
    decision: "fan_out",
    decisionReason: `balanced ${shards.map((shard) => shard.files.length).join("/")} cut at weight ${finalCutWeight} of ${graph.totalWeight} total (coupling density ${couplingDensity.toFixed(3)} < ${config.maxCouplingDensity})`,
  };
}

// ── Lifecycle seam (§6.1) ────────────────────────────────────────────

export interface SharderHookDeps {
  stateManager: StateManagerAPI;
  cwd: string;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to loadSharderConfig(cwd).enabled. */
  sharderEnabled?: boolean;
  /**
   * The completing plan attempt's id (C2-ADV-003). When supplied, a pending
   * plan posted under a DIFFERENT attempt is stale (same-cycle retry) and is
   * dropped, never sharded.
   */
  phaseAttemptId?: string;
}

/**
 * The sharder hook at the exact plan→implement transition. Flag-gated; with
 * no typed plan posted for the current cycle it degrades silently to the
 * single-slice checklist path. Returns the committed ShardPlan, or null when
 * the hook did not act (flag off / no pending plan).
 */
export function runSharderHook(deps: SharderHookDeps): ShardPlan | null {
  const config = loadSharderConfig(deps.cwd);
  const enabled = deps.sharderEnabled ?? config.enabled;
  if (!enabled) return null;

  const state = deps.stateManager.getState();
  if (!state || state.status !== "running") return null;
  const pending = state.shards.pendingPlan;
  if (!pending) {
    // Degradation observability (C2-ADV-006): flag on but no typed plan —
    // the single-slice path should be explained, not silent.
    log(`Sharder enabled but no typed plan pending for cycle ${state.cycle}; implement continues single-slice`);
    return null;
  }
  // Cycle + attempt binding (C2-ADV-003): only the transition of the SAME
  // attempt that posted the plan may consume it.
  if (pending.cycle !== state.cycle
    || (deps.phaseAttemptId && pending.phaseAttemptId !== deps.phaseAttemptId)) {
    log(`Dropping stale pending shard plan (posted cycle=${pending.cycle} attempt=${pending.phaseAttemptId}; current cycle=${state.cycle} attempt=${deps.phaseAttemptId ?? "unknown"})`);
    deps.stateManager.clearPendingShardPlan();
    return null;
  }

  const shardPlan = buildShardPlan(pending.plan, {
    runId: state.runId,
    cycle: state.cycle,
    cwd: deps.cwd,
    config,
  });
  deps.stateManager.recordShardPlan(shardPlan);
  deps.log?.(`Sharder: ${shardPlan.decision} — ${shardPlan.decisionReason}`);
  return shardPlan;
}
