/**
 * Worktree lifecycle + merge-back layer (deployment plan Ch. 6 §6.6, Campaign 4).
 *
 * The isolated-worktree primitive exists exactly once in the repository — it
 * was promoted here from src/agents/pool.ts (prepareIsolatedWorktree:
 * `git worktree add --detach` into a temp dir, `git diff --binary` patch
 * capture, process-exit cleanup registry; cleanup extracted into
 * removeWorktree, behavior identical) — and extended into a proper lifecycle
 * module:
 *
 *   - recoverWorktrees: SCOPED crash recovery (C4-ADV-004/C4-ADV-010). Two
 *     classes, harness-prefix-confined (pi-ig-agent-*, pi-ig-integration-*)
 *     so user ad-hoc worktrees and other tools' registrations are never
 *     touched: (a) registrations whose directories VANISHED (plain prune
 *     territory — a crashed process cannot run its in-memory cleanup
 *     registry), and (b) registrations whose directories SURVIVE from a dead
 *     creator (the realistic kill -9 case — a PID marker file written at
 *     creation decides liveness; alive or unmarked worktrees are left alone).
 *     Production caller: run restore (src/kernel/lifecycle.ts session_start).
 *   - mergeShardPlan: patch application onto a harness-owned integration
 *     branch in HEFT order (rank from the ledgered claims; input rank is only
 *     an explicit override), behind the iterativeGoal.mergeBack feature flag.
 *     Isolation defers conflicts to merge time rather than eliminating them
 *     (§6.6), so verification concentrates here: every completed shard's
 *     captured patch passes a gate before it lands — (1) per-shard allowlist
 *     verify (src/workspace/change-set.ts → verifyShardPatchAgainstScope,
 *     git-native and fail-closed), (2) the repository test suite on the
 *     merged tree, and (3) the extended unfinished-work gate
 *     (src/evaluator.ts → findUnfinishedWork), recorded as a post-verdict
 *     evidence snapshot here and ENFORCED at goal time by the evaluator
 *     (rejecting shard i because shard j has not merged yet would deadlock
 *     the fan-out — completion is the evaluator's gate, not the merge
 *     layer's). A completed shard emits merge_proposed; gate pass emits
 *     merge_verified; gate rejection returns the shard to claimed with the
 *     failure evidence attached (Figure D5: merge_proposed → failed →
 *     claimed — the repair loop transition; repair re-DISPATCH stays a
 *     scheduler concern, not this layer's).
 *
 * Integration branch strategy: one harness-owned local branch per run
 * (pi-ig/integration/<runId>, overridable — overrides must keep the pi-ig/
 * prefix and must not name an existing non-harness branch, C4-ADV-009), cut
 * from HEAD at first merge. Verified patches land as one commit per shard,
 * staging ONLY the patch's own file list (never bare `git add -A`,
 * C4-ADV-005), authored via per-command `-c user.name/-c user.email` so
 * repository config is never mutated and hooks still run. The integration
 * worktree is reused when one already tracks the branch (kill -9 leaves it
 * behind — fataling on "already used by worktree" would wedge every
 * subsequent merge) and removed after each batch; the branch keeps the
 * verified work.
 *
 * Patch application is 2-way only, deliberately (C4-ADV-013): shard patches
 * are captured from worktrees cut at the same HEAD the integration branch is
 * cut from, and merges run in one batch immediately after execution. A base
 * that went stale in between means HEAD moved mid-run — merging onto moved
 * ground would invalidate the batch's provenance, so that case SHOULD
 * reject (and does, at the apply gate) rather than silently 3-way merging.
 *
 * Gate part 2 runs in a FRESH worktree: the configured testCommand must work
 * there. npm-family commands short-circuit with a bootstrap-required message
 * when package.json declares dependencies but node_modules is absent
 * (C4-ADV-006) — configure testCommand to bootstrap (e.g. "npm ci &&
 * npm test") or vendor dependencies.
 *
 * Rollback (flag off, §8.7): mergeShardPlan refuses before touching anything
 * — patches keep surfacing as [ISOLATED_WORKTREE_PATCH] blocks for manual
 * application (pre-C4 behavior), and the evaluator's gate extension is
 * flag-guarded off.
 */

import { execFileSync, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ShardMergeRecord, ShardPlan } from "../domain/shard.js";
import { shardDispatchTaskId } from "../domain/shard.js";
import { readIterativeGoalSettings } from "../domain/project-settings.js";
import { logDebug } from "../logging.js";
import type { StateManagerAPI } from "../state.js";
import { verifyShardPatchAgainstScope } from "./change-set.js";

function log(msg: string) {
  logDebug("worktrees", msg);
}

// ── Isolated worktree primitive (promoted from src/agents/pool.ts) ────

export interface IsolatedWorkspace {
  path: string;
  /** The shard worktree's `git diff --binary` capture; "" when nothing changed. THROWS on git error (C4-ADV-011). */
  capturePatch(): string;
  cleanup(): void;
}

/**
 * PID marker written into every harness worktree at creation: recoverWorktrees
 * reclaims surviving directories only when their creator is provably dead
 * (kill -9 case), and never touches alive or unmarked worktrees (concurrent
 * runs, foreign provenance). Untracked, so it never enters a captured patch.
 */
const WORKTREE_MARKER_FILE = ".pi-ig-worktree.json";

function writeWorktreeMarker(worktreePath: string, kind: "shard" | "integration"): void {
  try {
    fs.writeFileSync(path.join(worktreePath, WORKTREE_MARKER_FILE), JSON.stringify({
      pid: process.pid,
      kind,
      createdAt: new Date().toISOString(),
    }));
  } catch (err) {
    log(`worktree marker write failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readWorktreeMarker(worktreePath: string): { pid?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(worktreePath, WORKTREE_MARKER_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as { pid?: unknown } : null;
  } catch {
    return null;
  }
}

export function prepareIsolatedWorktree(repoRoot: string, taskId: string): IsolatedWorkspace {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
  const safeId = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  const workspacePath = path.join(os.tmpdir(), `pi-ig-agent-${safeId}-${crypto.randomBytes(4).toString("hex")}`);
  execFileSync("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
  registerWorktreeForCleanup(repoRoot, workspacePath);
  writeWorktreeMarker(workspacePath, "shard");
  return {
    path: workspacePath,
    capturePatch() {
      // C4-ADV-011: a git diff failure must stay distinguishable from "no
      // changes" ("") — THROW, or merge-back could verify vanished work.
      // The pool catches this for its best-effort reader path; the merge
      // layer treats an unavailable patch as a rejection.
      return execFileSync("git", ["diff", "--binary"], { cwd: workspacePath, encoding: "utf8", timeout: 30_000 }).trim();
    },
    cleanup() {
      removeWorktree(repoRoot, workspacePath);
    },
  };
}

const pendingWorktreeCleanups = new Map<string, string>();
let cleanupHandlersRegistered = false;

function registerWorktreeForCleanup(repoRoot: string, workspacePath: string): void {
  pendingWorktreeCleanups.set(workspacePath, repoRoot);
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  const cleanupAll = () => {
    for (const [workspace, root] of pendingWorktreeCleanups.entries()) {
      removeWorktree(root, workspace);
    }
  };
  process.once("beforeExit", cleanupAll);
  process.once("exit", cleanupAll);
}

function unregisterWorktreeForCleanup(_repoRoot: string, workspacePath: string): void {
  pendingWorktreeCleanups.delete(workspacePath);
}

function removeWorktree(repoRoot: string, workspacePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", workspacePath], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
  } catch {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch {}
  }
  unregisterWorktreeForCleanup(repoRoot, workspacePath);
}

// ── Crash recovery (§6.6, §8.7) ──────────────────────────────────────

export interface WorktreeRecoveryReport {
  /** Registered worktree paths before recovery (main worktree included). */
  before: string[];
  after: string[];
  /** Harness registrations removed because their directories vanished. */
  pruned: string[];
  /** Harness registrations removed although their directories survived — the creating process is provably dead (kill -9 case). */
  reclaimed: string[];
  /** Non-harness registrations deliberately left alone (scoped recovery, C4-ADV-010). */
  skippedForeign: string[];
}

/** Harness worktree basename prefixes — recovery is confined to exactly these. */
export const HARNESS_WORKTREE_PREFIXES = ["pi-ig-agent-", "pi-ig-integration-"] as const;

function isHarnessWorktreePath(worktreePath: string): boolean {
  const base = path.basename(worktreePath);
  return HARNESS_WORKTREE_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function listWorktreePaths(repoRoot: string): string[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  return out.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours; ESRCH means dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Scoped crash recovery (C4-ADV-004/C4-ADV-010): reclaims only HARNESS-prefixed
 * worktree registrations — never the user's ad-hoc worktrees, never other
 * tools' registrations, never a concurrent run's live worktree. Two classes:
 * directories that vanished (a crashed process cannot run its cleanup
 * registry) and directories that SURVIVED a provably dead creator (kill -9;
 * the PID marker decides). Production caller: run restore
 * (src/kernel/lifecycle.ts session_start), exception-contained there.
 */
export function recoverWorktrees(repoRoot: string): WorktreeRecoveryReport {
  const before = listWorktreePaths(repoRoot);
  const pruned: string[] = [];
  const reclaimed: string[] = [];
  const skippedForeign: string[] = [];
  for (const entry of before) {
    if (!isHarnessWorktreePath(entry)) {
      skippedForeign.push(entry);
      continue;
    }
    if (!fs.existsSync(entry)) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", entry], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
        pruned.push(entry);
      } catch (err) {
        log(`scoped prune of ${entry} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    const marker = readWorktreeMarker(entry);
    const pid = typeof marker?.pid === "number" && Number.isInteger(marker.pid) && marker.pid > 0 ? marker.pid : null;
    if (pid !== null && !pidAlive(pid)) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", entry], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
        reclaimed.push(entry);
      } catch (err) {
        log(`reclaim of ${entry} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Alive creator or unmarked → left alone (concurrent run / foreign).
  }
  const after = listWorktreePaths(repoRoot);
  return { before, after, pruned, reclaimed, skippedForeign };
}

// ── Feature flag + tuning (.pi/settings.json → iterativeGoal.mergeBack) ──

export interface MergeBackConfig {
  /**
   * Merge-back rollback flag (§8.7): disabled by default — captured patches
   * keep surfacing as [ISOLATED_WORKTREE_PATCH] blocks for manual
   * application, and the evaluator's merge_verified gate extension stays
   * inert (flag-guarded in src/evaluator.ts → findUnfinishedWork).
   */
  enabled: boolean;
  /**
   * Integration branch override; null → pi-ig/integration/<runId>. Overrides
   * must keep the pi-ig/ harness prefix (C4-ADV-009) — anything else is
   * ignored loudly and the derived name is used.
   */
  integrationBranch: string | null;
  /**
   * Repository test suite command run on the merged tree (gate part 2), in a
   * FRESH worktree: it must bootstrap its own dependencies (e.g. "npm ci &&
   * npm test") or the repo must vendor them. npm-family commands fail with a
   * bootstrap-required message when package.json declares dependencies but
   * node_modules is absent (C4-ADV-006).
   */
  testCommand: string;
  testTimeoutMs: number;
}

export const DEFAULT_MERGE_TEST_COMMAND = "npm test";
export const DEFAULT_MERGE_TEST_TIMEOUT_MS = 120_000;
/** Harness confinement for integration branches (C4-ADV-009). */
export const INTEGRATION_BRANCH_PREFIX = "pi-ig/";
/** Per-command commit identity for shard merge commits (never repo config). */
export const MERGE_COMMIT_AUTHOR = { name: "pi-iterative-goal", email: "pi-iterative-goal@localhost" } as const;

export function loadMergeBackConfig(cwd: string): MergeBackConfig {
  // Shared guarded reader (src/domain/project-settings.ts — no per-module copy).
  const mergeBack = readIterativeGoalSettings(cwd).mergeBack;
  const config = mergeBack && typeof mergeBack === "object" ? mergeBack as Record<string, unknown> : {};
  const testTimeout = typeof config.testTimeoutMs === "number" && Number.isFinite(config.testTimeoutMs)
    ? Math.max(1_000, Math.min(config.testTimeoutMs, 1_800_000))
    : DEFAULT_MERGE_TEST_TIMEOUT_MS;
  let integrationBranch: string | null = null;
  if (typeof config.integrationBranch === "string" && config.integrationBranch.trim().length > 0) {
    const override = config.integrationBranch.trim();
    if (override.startsWith(INTEGRATION_BRANCH_PREFIX)) {
      integrationBranch = override;
    } else {
      // C4-ADV-009: an unconstrained override could name an existing user
      // branch (main) and receive verified shard commits — refuse loudly.
      log(`mergeBack.integrationBranch override "${override}" refused: it must start with ${INTEGRATION_BRANCH_PREFIX} (harness confinement); using the derived per-run branch`);
    }
  }
  return {
    enabled: config.enabled === true,
    integrationBranch,
    testCommand: typeof config.testCommand === "string" && config.testCommand.trim().length > 0
      ? config.testCommand.trim()
      : DEFAULT_MERGE_TEST_COMMAND,
    testTimeoutMs: Math.floor(testTimeout),
  };
}

// ── Shard patch artifacts (C4-OUS-001) ────────────────────────────────

/**
 * Persists a completed shard's captured patch bytes into the run dir and
 * returns the repo-relative artifact path (ledgered on the claim via
 * recordShardFinished). Called by the scheduler at shard completion so a
 * crash before merge-back never strands the work — a warm restart rebuilds
 * merge inputs from ledgered claims + these artifacts.
 */
export function persistShardPatchArtifact(
  stateManager: StateManagerAPI,
  cycle: number,
  shardId: string,
  patch: string,
  cwd: string,
): string | null {
  try {
    const safeId = shardId.replace(/[^A-Za-z0-9._-]/g, "-");
    const absolute = stateManager.getArtifactPath(cycle, "implement", `shard-${safeId}.patch`);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, patch);
    return path.relative(cwd, absolute);
  } catch (err) {
    log(`persistShardPatchArtifact failed for shard ${shardId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Reads a ledgered patch artifact back; null when missing/unreadable (fail-closed at the merge gate). */
export function readShardPatchArtifact(cwd: string, artifactPath: string): string | null {
  try {
    const absolute = path.join(cwd, artifactPath);
    if (!fs.existsSync(absolute)) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

// ── Merge driver (§6.6) ───────────────────────────────────────────────

/**
 * One completed shard's captured output, in whatever order execution finished.
 * patch === null means capture FAILED or the ledgered artifact is missing —
 * the merge layer rejects the shard rather than merge-verifying vanished work
 * (C4-ADV-011); "" means the shard genuinely changed nothing.
 */
export interface ShardMergeInput {
  shardId: string;
  patch: string | null;
  /**
   * Explicit rank override only (C4-OUS-009): the merge order reads the HEFT
   * rank from the ledgered claim; this field exists for callers that must
   * deviate deliberately. Omit in normal operation.
   */
  rank?: number | null;
}

export interface MergeBackDeps {
  stateManager: StateManagerAPI;
  cwd: string;
  /** Injectable for tests; defaults to loadMergeBackConfig(cwd). */
  config?: MergeBackConfig;
  /** Injectable test runner; defaults to execSync(testCommand) in the integration worktree. */
  runTests?: (worktreePath: string, command: string, timeoutMs: number) => { ok: boolean; output: string };
  /**
   * Gate part 3 evidence snapshot (wired from src/evaluator.ts →
   * findUnfinishedWork by the caller). Called with the shard being verified
   * so the snapshot EXCLUDES it — the recorded evidence is the post-verdict
   * view and the ledger shows the gate clearing (C4-OUS-006).
   */
  snapshotUnfinishedWork?: (excludeShardId?: string) => { pendingTaskItems: number; unverifiedShards: number };
  now?: () => string;
  log?: (message: string) => void;
}

export interface ShardMergeRejection {
  shardId: string;
  /** Which gate rejected: capture (patch unavailable), allowlist (part 1), apply (patch conflict), tests (part 2). */
  gate: "capture" | "allowlist" | "apply" | "tests";
  reason: string;
}

export interface MergeBackReport {
  enabled: boolean;
  planId: string | null;
  integrationBranch: string | null;
  /** Base ref the integration branch was cut from (null when the branch pre-existed). */
  baseSha: string | null;
  /** Shard ids in HEFT merge order (claim-ledgered rank descending; unranked last, ties by posted index). */
  mergeOrder: string[];
  verified: string[];
  rejected: ShardMergeRejection[];
  /** Shards not proposed (not completed, already verified, unknown) with the reason. */
  skipped: Array<{ shardId: string; reason: string }>;
  commits: Array<{ shardId: string; sha: string }>;
  /** Gate-rejected shards returned to claimed with failure evidence attached (Figure D5 repair loop). */
  repaired: string[];
  reason: string;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const NPM_FAMILY_COMMAND = /^\s*(npm|npx|yarn|pnpm)\b/;

function defaultRunTests(worktreePath: string, command: string, timeoutMs: number): { ok: boolean; output: string } {
  // C4-ADV-006: gate part 2 runs in a FRESH worktree. An npm-family command
  // against declared-but-uninstalled dependencies fails with a clear
  // bootstrap-required message instead of a raw npm error.
  if (NPM_FAMILY_COMMAND.test(command)) {
    try {
      const pkgPath = path.join(worktreePath, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        const declared = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
        if (declared > 0 && !fs.existsSync(path.join(worktreePath, "node_modules"))) {
          return {
            ok: false,
            output: `bootstrap-required: '${command}' needs ${declared} declared dependenc(y/ies), but the fresh integration worktree has no node_modules. Configure iterativeGoal.mergeBack.testCommand to bootstrap (e.g. "npm ci && npm test") or vendor dependencies (C4-ADV-006).`,
          };
        }
      }
    } catch {
      // A package.json we cannot parse is the test runner's own problem — run it.
    }
  }
  try {
    const output = execSync(command, { cwd: worktreePath, encoding: "utf8", timeout: timeoutMs });
    return { ok: true, output };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n") };
  }
}

/** The worktree path currently tracking `branch`, or null (porcelain scan). */
function findWorktreeForBranch(repoRoot: string, branch: string): string | null {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
    for (const block of out.split(/\r?\n\r?\n/)) {
      if (!block.split(/\r?\n/).includes(`branch refs/heads/${branch}`)) continue;
      const line = block.split(/\r?\n/).find((entry) => entry.startsWith("worktree "));
      if (line) return line.slice("worktree ".length);
    }
  } catch { /* treat as absent */ }
  return null;
}

/**
 * Branch confinement (C4-ADV-009): an existing integration branch must be
 * harness-authored (its tip commit carries the merge identity). Anything
 * else — e.g. an override naming a pre-existing user branch — refuses.
 */
function assertHarnessOwnedBranch(repoRoot: string, branch: string): void {
  let author = "";
  try {
    author = execFileSync("git", ["log", "-1", "--format=%ae", branch], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return; // Branch does not exist yet — it will be created below.
  }
  if (author !== MERGE_COMMIT_AUTHOR.email) {
    throw new Error(`integration branch ${branch} exists but its tip commit is not harness-authored (${author || "unknown"}) — refusing to merge onto a non-harness branch (C4-ADV-009)`);
  }
}

/**
 * Applies a shard plan's captured patches onto the integration branch in HEFT
 * order, gating each through merge_proposed → (gates) → merge_verified, and
 * returning gate-rejected shards to claimed with failure evidence attached.
 * Flag-gated: with mergeBack disabled it returns before touching the ledger,
 * git, or the filesystem beyond config reads (§8.7 rollback).
 *
 * Idempotent: shards already merge_verified are skipped, so a re-driven
 * transition never re-applies or re-commits verified work.
 */
export async function mergeShardPlan(
  plan: ShardPlan,
  inputs: ShardMergeInput[],
  deps: MergeBackDeps,
): Promise<MergeBackReport> {
  const config = deps.config ?? loadMergeBackConfig(deps.cwd);
  const now = deps.now ?? (() => new Date().toISOString());
  const runTests = deps.runTests ?? defaultRunTests;
  const empty: MergeBackReport = {
    enabled: config.enabled,
    planId: plan.id,
    integrationBranch: null,
    baseSha: null,
    mergeOrder: [],
    verified: [],
    rejected: [],
    skipped: [],
    commits: [],
    repaired: [],
    reason: "",
  };
  if (!config.enabled) {
    return {
      ...empty,
      reason: "merge-back disabled by flag — patches surface as [ISOLATED_WORKTREE_PATCH] blocks for manual application (§8.7 rollback)",
    };
  }
  const state = deps.stateManager.getState();
  if (!state) throw new Error("mergeShardPlan requires an active run");
  const runId = state.runId;
  const branch = config.integrationBranch ?? `pi-ig/integration/${runId.replace(/[^A-Za-z0-9._/-]/g, "-")}`;

  const shardIndex = new Map(plan.shards.map((shard) => [shard.id, shard.index]));
  const claimsByShardId = new Map(
    state.shards.claims
      .filter((claim) => claim.planId === plan.id && claim.cycle === plan.cycle)
      .map((claim) => [claim.shardId, claim]),
  );
  // HEFT merge order (§6.6): the ledgered claim rank is the source of truth
  // (C4-OUS-009); ShardMergeInput.rank is an explicit override only. Unranked
  // shards sort last; ties keep posted (partition index) order.
  const effectiveRank = (input: ShardMergeInput): number | null =>
    input.rank ?? claimsByShardId.get(input.shardId)?.rank ?? null;
  const ordered = [...inputs].sort((a, b) => {
    const rankA = effectiveRank(a) ?? Number.NEGATIVE_INFINITY;
    const rankB = effectiveRank(b) ?? Number.NEGATIVE_INFINITY;
    if (rankA !== rankB) return rankB - rankA;
    return (shardIndex.get(a.shardId) ?? 0) - (shardIndex.get(b.shardId) ?? 0);
  });
  const report: MergeBackReport = { ...empty, integrationBranch: branch, mergeOrder: ordered.map((input) => input.shardId) };

  let worktreePath: string | null = null;
  try {
    // Lazily create the integration branch + worktree on the first shard that
    // is actually proposed — a fully-skipped batch leaves no git trace.
    let branchReady = false;
    const ensureWorktree = (): string => {
      if (worktreePath) return worktreePath;
      if (!branchReady) {
        const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: deps.cwd, encoding: "utf8" }).trim();
        try {
          execFileSync("git", ["rev-parse", "--verify", branch], { cwd: deps.cwd, stdio: "ignore" });
          assertHarnessOwnedBranch(deps.cwd, branch);
        } catch (err) {
          if (err instanceof Error && err.message.includes("refusing to merge onto a non-harness branch")) throw err;
          execFileSync("git", ["branch", branch, baseSha], { cwd: deps.cwd, stdio: "ignore" });
          report.baseSha = baseSha;
        }
        branchReady = true;
      }
      // C4-ADV-004: a previous run killed mid-merge can leave this branch's
      // integration worktree behind. Reuse/reset it instead of fataling on
      // "already used by worktree"; a vanished directory is pruned inline.
      const existing = findWorktreeForBranch(deps.cwd, branch);
      if (existing && fs.existsSync(existing)) {
        execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: existing, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd"], { cwd: existing, stdio: "ignore" });
        writeWorktreeMarker(existing, "integration");
        registerWorktreeForCleanup(deps.cwd, existing);
        worktreePath = existing;
        return worktreePath;
      }
      if (existing) {
        try { execFileSync("git", ["worktree", "remove", "--force", existing], { cwd: deps.cwd, stdio: "ignore", timeout: 30_000 }); } catch {}
      }
      const safeRun = runId.replace(/[^A-Za-z0-9._-]/g, "-");
      worktreePath = path.join(os.tmpdir(), `pi-ig-integration-${safeRun}-${crypto.randomBytes(4).toString("hex")}`);
      // Branch-tracked (not --detach): verified commits advance the branch ref.
      execFileSync("git", ["worktree", "add", worktreePath, branch], { cwd: deps.cwd, stdio: "ignore" });
      registerWorktreeForCleanup(deps.cwd, worktreePath);
      writeWorktreeMarker(worktreePath, "integration");
      return worktreePath;
    };

    for (const input of ordered) {
      const shard = plan.shards.find((item) => item.id === input.shardId);
      if (!shard) {
        report.skipped.push({ shardId: input.shardId, reason: "shard not in plan" });
        continue;
      }
      const key = { planId: plan.id, cycle: plan.cycle, shardId: input.shardId };
      const priorMerge = state.shards.merges.find(
        (item) => item.planId === key.planId && item.cycle === key.cycle && item.shardId === key.shardId,
      );
      if (priorMerge?.status === "verified") {
        report.skipped.push({ shardId: input.shardId, reason: "already merge_verified" });
        continue;
      }
      const claim = claimsByShardId.get(input.shardId);
      if (claim?.status !== "completed") {
        report.skipped.push({ shardId: input.shardId, reason: `claim status is ${claim?.status ?? "missing"}, not completed` });
        continue;
      }

      // Gate rejection (Figure D5): merge_proposed → failed → claimed, with
      // the failure evidence attached to the repair re-claim. The integration
      // worktree is restored to the last verified state first, so siblings
      // merge onto verified work only.
      const reject = (gate: ShardMergeRejection["gate"], reason: string): void => {
        if (worktreePath) {
          try {
            execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: worktreePath, stdio: "ignore" });
            execFileSync("git", ["clean", "-fd"], { cwd: worktreePath, stdio: "ignore" });
            writeWorktreeMarker(worktreePath, "integration");
          } catch (err) {
            log(`integration worktree restore after ${gate} rejection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        deps.stateManager.recordShardFinished(input.shardId, {
          runId, planId: plan.id, cycle: plan.cycle, status: "failed", error: reason,
        });
        deps.stateManager.recordShardClaimed({
          shardId: input.shardId,
          planId: plan.id,
          runId,
          cycle: plan.cycle,
          status: "claimed",
          workerSlot: claim.workerSlot,
          rank: claim.rank,
          // Repair pending re-dispatch: no dispatch task exists yet, and the
          // null taskId keeps restore-time crash reconciliation (C3-ADV-009)
          // from failing this claim for a task that never ran.
          taskId: null,
          claimedAt: now(),
          finishedAt: null,
          error: reason,
          patchArtifactPath: claim.patchArtifactPath,
        }, {
          repairLoop: true,
          rejectedFrom: "merge_gate",
          gateFailure: { gate, reason, patchSha256: claim.patchArtifactPath ? sha256Text(input.patch ?? "") : null },
        });
        report.rejected.push({ shardId: input.shardId, gate, reason });
        report.repaired.push(input.shardId);
        deps.log?.(`merge gate REJECTED shard ${input.shardId} (${gate}): ${reason} — returned to claimed for repair (Figure D5)`);
      };

      // C4-ADV-011: an unavailable patch (capture failure / missing ledgered
      // artifact) is a rejection, never a merge_verified with vanished work.
      if (input.patch === null) {
        reject("capture", "patch unavailable (capture failed or ledgered artifact missing) — refusing to merge-verify vanished work");
        continue;
      }
      const patch = input.patch.trim();
      const patchSha256 = sha256Text(patch);
      const proposedAt = now();
      const mergeRecord: ShardMergeRecord = {
        shardId: input.shardId,
        planId: plan.id,
        runId,
        cycle: plan.cycle,
        status: "proposed",
        patchSha256,
        patchArtifactPath: claim.patchArtifactPath,
        integrationBranch: branch,
        rank: effectiveRank(input),
        gate: null,
        error: null,
        proposedAt,
        verifiedAt: null,
      };
      deps.stateManager.recordMergeProposed(mergeRecord);

      // Gate part 1 (§6.6): the captured diff against the shard's own
      // path-scope allowlist, before any application is attempted. Git-native
      // and fail-closed (C4-ADV-001/C4-ADV-002) — unparseable sections and
      // un-normalizable paths are violations, never throws.
      const scopeCheck = verifyShardPatchAgainstScope(patch, shard.allowedPaths, { cwd: deps.cwd });
      if (scopeCheck.allowlistViolation) {
        const detail = [
          scopeCheck.extraFiles.length > 0 ? `files outside the shard write scope: ${scopeCheck.extraFiles.join(", ")}` : "",
          scopeCheck.parseErrors.length > 0 ? `unparseable patch sections (fail-closed): ${scopeCheck.parseErrors.join(" | ")}` : "",
        ].filter(Boolean).join("; ");
        reject("allowlist", `patch rejected by the shard scope gate — ${detail}`);
        continue;
      }

      const tree = ensureWorktree();
      if (patch.length > 0) {
        // Conflict surface (§6.6): isolation deferred conflicts to merge
        // time; a patch that no longer applies onto the merged tree (e.g.
        // two shard diffs touching the same bridge file) is rejected here.
        // 2-way only, deliberately — a stale base means HEAD moved mid-run,
        // which should reject rather than silently 3-way merge (C4-ADV-013).
        // The ledger hash rides the trimmed capture, but git apply requires
        // the trailing newline the capture's .trim() removed.
        const applyPayload = patch.endsWith("\n") ? patch : `${patch}\n`;
        try {
          execFileSync("git", ["apply", "--check", "-"], { cwd: tree, input: applyPayload, stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
          reject("apply", `patch does not apply onto the integration branch (merge-time conflict): ${stderr || (err instanceof Error ? err.message : String(err))}`);
          continue;
        }
        execFileSync("git", ["apply", "-"], { cwd: tree, input: applyPayload, stdio: ["pipe", "ignore", "pipe"] });
      }

      // Gate part 2 (§6.6): the repository test suite on the MERGED tree.
      const tests = runTests(tree, config.testCommand, config.testTimeoutMs);
      if (!tests.ok) {
        reject("tests", `repository test suite failed on the merged tree (${config.testCommand}): ${tests.output.slice(-800)}`);
        continue;
      }

      // Gate part 3 evidence snapshot, POST-verdict view: the shard being
      // verified is excluded so the ledger shows the gate clearing
      // (C4-OUS-006). Goal-time enforcement stays with the evaluator.
      const unfinished = deps.snapshotUnfinishedWork?.(input.shardId) ?? null;

      // Land the verified patch: one commit per shard on the integration
      // branch, staging ONLY the patch's own file list (C4-ADV-005 — test
      // side effects like coverage/ never enter the shard commit whose
      // message carries the patch provenance hash).
      let sha = "";
      if (patch.length > 0 && scopeCheck.changedFiles.length > 0) {
        execFileSync("git", ["add", "-A", "--", ...scopeCheck.changedFiles], { cwd: tree, stdio: "ignore" });
        const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: tree, encoding: "utf8" }).trim();
        if (staged) {
          execFileSync("git", [
            "-c", `user.name=${MERGE_COMMIT_AUTHOR.name}`,
            "-c", `user.email=${MERGE_COMMIT_AUTHOR.email}`,
            "commit", "-q", "-m",
            `merge(${input.shardId}): plan ${plan.id} cycle ${plan.cycle}\n\nmerge_verified gate evidence\npatchSha256=${patchSha256}`,
          ], { cwd: tree, stdio: "ignore" });
          sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).trim();
        }
      }

      deps.stateManager.recordMergeVerified(input.shardId, {
        runId,
        planId: plan.id,
        cycle: plan.cycle,
        gate: {
          allowlistOk: true,
          extraFiles: [],
          testsOk: true,
          testCommand: config.testCommand,
          unfinishedWork: unfinished,
        },
        verifiedAt: now(),
      });
      report.verified.push(input.shardId);
      if (sha) report.commits.push({ shardId: input.shardId, sha });
      deps.log?.(`merge_verified shard ${input.shardId} onto ${branch}${sha ? ` (${sha.slice(0, 12)})` : " (no changes)"}`);
    }
  } finally {
    if (worktreePath) removeWorktree(deps.cwd, worktreePath);
  }

  report.reason = `merge-back over ${report.mergeOrder.length} shard patch(es) in HEFT order: ${report.verified.length} verified, ${report.rejected.length} rejected, ${report.skipped.length} skipped`;
  return report;
}

// ── Lifecycle seam (§6.6) ─────────────────────────────────────────────

/** Minimal scheduler-report shape the merge hook consumes (C3 ShardExecutionReport). */
export interface MergeBackHookSchedulerReport {
  outcomes: Array<{ task: { id: string }; ok: boolean; result: { patch?: string | null } | null }>;
}

export interface MergeBackHookDeps {
  stateManager: StateManagerAPI;
  cwd: string;
  /**
   * The scheduler report from the same plan→implement transition. Absent
   * (warm restart — the scheduler's idempotency skip produces no report),
   * the hook rebuilds its inputs from ledgered claims + patch artifacts
   * (C4-OUS-001) instead of starving.
   */
  schedulerReport?: MergeBackHookSchedulerReport | null;
  /** Gate part 3 evidence snapshot (lifecycle wires src/evaluator.ts → findUnfinishedWork). */
  snapshotUnfinishedWork?: (excludeShardId?: string) => { pendingTaskItems: number; unverifiedShards: number };
  /** Injectable for tests; defaults to loadMergeBackConfig(cwd).enabled. */
  mergeBackEnabled?: boolean;
  log?: (message: string) => void;
}

/**
 * The merge-back hook at the plan→implement transition, called from
 * advanceToNextPhase immediately after runSchedulerHook — the scheduler
 * executes the fan_out plan synchronously, and the completed shards' captured
 * patches merge onto the integration branch in HEFT order. Flag-gated:
 * with mergeBack disabled it returns before touching anything, so flag-off
 * behavior is byte-identical to pre-C4 (§8.7 rollback). Exceptions propagate
 * to the lifecycle call site's try/catch, which degrades to the single-slice
 * implement prompt.
 */
export async function runMergeBackHook(deps: MergeBackHookDeps): Promise<MergeBackReport | null> {
  const enabled = deps.mergeBackEnabled ?? loadMergeBackConfig(deps.cwd).enabled;
  if (!enabled) return null;

  const state = deps.stateManager.getState();
  if (!state || state.status !== "running") return null;
  const plan = [...state.shards.plans].reverse().find(
    (candidate) => candidate.cycle === state.cycle && candidate.decision === "fan_out" && candidate.shards.length > 0,
  );
  if (!plan) return null;

  // Same-transition hand-off: match outcomes to shards via the scheduler's
  // OWN task-id helper (C4-OUS-008 — no duplicated string convention).
  const outcomes = deps.schedulerReport?.outcomes ?? [];
  const inputs: ShardMergeInput[] = [];
  let matched = 0;
  for (const shard of plan.shards) {
    const outcome = outcomes.find((candidate) => candidate.task.id === shardDispatchTaskId(plan.cycle, shard.id));
    if (!outcome) continue;
    matched += 1;
    // result.patch undefined/null = capture failure → null → capture-gate
    // rejection downstream (C4-ADV-011), never a silent merge.
    inputs.push({ shardId: shard.id, patch: outcome.result?.patch ?? null });
  }
  if (matched === 0) {
    if (deps.schedulerReport) {
      deps.log?.("merge-back hook: scheduler report carried no shard outcomes for this plan — falling back to ledgered claims + patch artifacts");
    }
    // Warm-restart rebuild (C4-OUS-001): the scheduler's idempotency skip
    // starves the in-memory hand-off, so inputs come from the ledger —
    // completed claims plus their persisted patch artifacts.
    for (const shard of plan.shards) {
      const claim = state.shards.claims.find(
        (item) => item.planId === plan.id && item.cycle === plan.cycle && item.shardId === shard.id,
      );
      if (claim?.status !== "completed") continue;
      inputs.push({
        shardId: shard.id,
        patch: claim.patchArtifactPath ? readShardPatchArtifact(deps.cwd, claim.patchArtifactPath) : null,
      });
    }
  }
  if (inputs.length === 0) {
    deps.log?.("merge-back hook: no completed shard patches to merge (enabled hook found zero matching outcomes, C4-OUS-008)");
    return null;
  }

  return await mergeShardPlan(plan, inputs, {
    stateManager: deps.stateManager,
    cwd: deps.cwd,
    snapshotUnfinishedWork: deps.snapshotUnfinishedWork,
    log: deps.log,
  });
}
