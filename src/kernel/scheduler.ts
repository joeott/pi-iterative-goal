/**
 * Post-plan scheduler + assignment (deployment plan Ch. 6 §6.4–6.5, Campaign 3).
 *
 * Pipeline: shard plan (ShardPlan, committed by C2's sharder as shard_posted)
 * → shard DAG (task-level dependsOn from the typed plan; shard-level edges
 * from cross-shard contracts) → HEFT upward ranks with TELEMETRY-CALIBRATED
 * costs → earliest-finish-time placement on the long-lived pool's concurrency
 * slots → single-round contract-net-style award (satisficing, §6.5 — one
 * announce/bid/award round per step, no re-announcement or reject/confirm
 * phase) → claims ledgered as shard_claimed / shard_completed / shard_failed.
 * Dispatch goes through dispatchAgentTask (src/agents/run-pool.ts) — THE
 * single dispatch path; the broker gate and subagent ledger wrapping are not
 * re-implemented here.
 *
 * Production wiring (C3-ADV-001): runSchedulerHook is called at the exact
 * plan→implement seam in src/kernel/lifecycle.ts, right after runSharderHook
 * — the sharder commits shard_posted, the scheduler consumes it in the same
 * transition when both flags are on. The hook is flag-gated (default OFF) and
 * exception-contained: with the flag off it returns before touching anything,
 * and a scheduler failure degrades to the single-slice implement prompt
 * rather than wedging the loop motor. The error-cascade monitor's production
 * caller is executeShardPlan (C3-OUS-006): it scans the run ledger after each
 * execution and surfaces signatures through the log and the report.
 *
 * Honesty constraints (§6.4, §7.2 static-estimate fragility):
 * - Costs are calibrated ONLY from the empirical AgentResult.usage
 *   distributions persisted with subagent_finished events. There is no
 *   hard-coded cost table and no hard-coded fallback constant: with zero
 *   telemetry samples the scheduler REFUSES ranks entirely and falls back to
 *   conservative default-concurrency placement (readiness-based topological
 *   order), which computes no ranks and no timed placements. Fewer than
 *   MIN_COST_SAMPLES completed-with-usage samples of the DISPATCH ROLE also
 *   fall back — one sample, or samples of unrelated roles alone, do not
 *   calibrate HEFT (C3-ADV-003).
 * - HEFT carries no dominance guarantee, so ordering is a default, never a
 *   proof: on telemetry drift beyond threshold OR shard failure the global
 *   view is re-run and UNSTARTED steps are re-ranked (§6.5 periodic global
 *   critic; failures never enter the cost model — buildCostModel filters
 *   completed-with-usage, so a failure-triggered re-plan re-ranks on the
 *   same model, reassigning work around the failure). Started steps keep
 *   their recorded award — claims already ledgered are immutable history,
 *   so re-ranking them would rewrite the audit trail.
 *
 * Residual v1 limits (documented, not hidden):
 * - Telemetry granularity is per ROLE. SubagentTaskRecord (C1) carries no
 *   modelProfile field, so §6.4's "per role and model profile" calibration
 *   degrades to per-role; adding the field is a C1-ledger extension.
 * - The pool is homogeneous: every concurrency slot advertises the dispatch
 *   role profile's permittedEffects, so Cap scores differentiate only via
 *   PlanTaskSchema.requiredCapabilities; per-worker heterogeneity is v2.
 * - Contract edges (symmetrized by the sharder) carry no import direction;
 *   they are oriented by partition order (lower block index first) and
 *   skipped when dependsOn already orders the pair or a cycle would result.
 *   Because that orientation can invert true producer/consumer flow,
 *   contract-ONLY edges inform rank hand-off costs but never gate execution
 *   readiness (C3-ADV-005).
 * - A genuine failed shard's dependents are marked blocked and left
 *   unclaimed; the semantic repair loop is NOT automatic in v1 (§6.6 assigns
 *   repair to the merge layer, C4). Infrastructure-interrupted claims marked
 *   process_restart are different: a restored transition safely re-dispatches
 *   only those episodes and never repeats already-completed work.
 * - EFT placement uses no gap insertion (classic HEFT list scheduling only).
 * - The cascade monitor reads "intervening verification" strictly
 *   (C3-ADV-012): only the failed shard's own re-completion (a successful
 *   repair re-run) or a merge_verified event (C4, forward-compatible) heals
 *   an episode — a CONSUMER's own clean completion does NOT count, so a
 *   downstream step that happens to succeed on poisoned input still flags.
 * - typed-plan checks[].command fields are ledger-scrubbed and INERT: the
 *   executor never reads them; shard prompts render titles/files/contracts.
 */

import * as fs from "node:fs";
import type { AgentRole, AgentTask } from "../agents/pool.js";
import { DEFAULT_SWARM_CONCURRENCY, MAX_SWARM_CONCURRENCY } from "../agents/pool.js";
import { getRoleProfile } from "../agents/roles.js";
import { dispatchAgentTask, getRunAgentPool, type DispatchOutcome } from "../agents/run-pool.js";
import { CapabilityBroker } from "../capabilities/broker.js";
import { PolicyEngine } from "../policy/engine.js";
import type { AgentPool } from "../agents/pool.js";
import { serializePathScope } from "../domain/path-scope.js";
import { requireModelRoute } from "../domain/model-roster.js";
import { readIterativeGoalSettings } from "../domain/project-settings.js";
import type { ShardPlan } from "../domain/shard.js";
import { shardDispatchTaskId } from "../domain/shard.js";
import { logDebug } from "../logging.js";
import type { StateManagerAPI } from "../state.js";
import { buildAgentTaskFromProfile } from "../subagents.js";
import type { IterativeGoalState, SubagentTaskRecord, SubagentUsageCounters } from "../types.js";
import { persistShardPatchArtifact } from "../workspace/worktrees.js";

function log(msg: string) {
  logDebug("scheduler", msg);
}

// ── Feature flag + tuning (.pi/settings.json → iterativeGoal.scheduler) ──

export interface SchedulerConfig {
  /**
   * Scheduler bypass flag (§8.6 rollback): disabled by default — shard steps
   * execute in posted order through the existing dispatch at default
   * concurrency, so C2's output remains executable end-to-end.
   */
  enabled: boolean;
  /** Pool concurrency cap: worker slots AND the announcement shortlist bound (bounded fan-out, §6.5). */
  concurrency: number;
  /** Re-plan trigger: max relative per-role mean-cost deviation that counts as drift (§6.4). */
  driftThreshold: number;
  /** Minimum wall-clock gap between global re-plans (cadence guard against thrash). */
  replanIntervalMs: number;
  /** Policy dial α — weight of capability match in bid utility (high α prices accuracy, §6.5). */
  alpha: number;
  /** Policy dial β — weight of telemetry-estimated cost in bid utility (high β prices thrift, §6.5). */
  beta: number;
  /**
   * Optional exact-roster profile for production shard implementers. When
   * absent, the Implementer role's canonical default remains authoritative.
   * An invalid explicit value is carried into the dispatch gate and rejected
   * by requireModelRoute before any worker process is spawned; it is never
   * silently replaced with another model.
   */
  workerModelProfile: string | null;
}

export const DEFAULT_DRIFT_THRESHOLD = 0.5;
export const DEFAULT_REPLAN_INTERVAL_MS = 60_000;
/**
 * Minimum completed-with-usage samples of the DISPATCH ROLE before HEFT
 * leaves the conservative fallback (C3-ADV-003): a single sample is a point,
 * not a distribution, and samples of unrelated roles alone must not
 * "calibrate" the dispatch role through the global mean. Below this count
 * the scheduler stays on the documented no-telemetry path.
 */
export const MIN_COST_SAMPLES = 2;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(num, max));
}

export function loadSchedulerConfig(cwd: string): SchedulerConfig {
  // Shared guarded reader (src/domain/project-settings.ts — no per-module copy).
  const scheduler = readIterativeGoalSettings(cwd).scheduler;
  const config = scheduler && typeof scheduler === "object" ? scheduler as Record<string, unknown> : {};
  return {
    enabled: config.enabled === true,
    concurrency: Math.floor(clampNumber(config.concurrency, DEFAULT_SWARM_CONCURRENCY, 1, MAX_SWARM_CONCURRENCY)),
    driftThreshold: clampNumber(config.driftThreshold, DEFAULT_DRIFT_THRESHOLD, 0.05, 5),
    replanIntervalMs: Math.floor(clampNumber(config.replanIntervalMs, DEFAULT_REPLAN_INTERVAL_MS, 0, 3_600_000)),
    alpha: clampNumber(config.alpha, 1, 0, 100),
    beta: clampNumber(config.beta, 1, 0, 100),
    // Preserve an explicitly configured selector byte-for-byte. Empty or
    // whitespace-padded values are inexact inputs and must reach the exact
    // roster gate as errors rather than becoming a default/substitute route.
    workerModelProfile: typeof config.workerModelProfile === "string" ? config.workerModelProfile : null,
  };
}

// ── Shard DAG construction (§6.4) ────────────────────────────────────

export interface ShardDagEdge {
  /** Upstream shard id (must finish first). */
  from: string;
  /** Downstream shard id. */
  to: string;
  /** Cross-shard contract weight feeding the hand-off cost c̄; 0 for dependsOn-only edges. */
  contractWeight: number;
  /**
   * "dependsOn" edges come from the typed plan and gate execution readiness.
   * "contract" edges come from cross-shard contracts alone: they inform rank
   * hand-off costs but NEVER gate readiness — their partition-order
   * orientation can invert true producer/consumer flow (C3-ADV-005).
   */
  kind: "dependsOn" | "contract";
}

export interface ShardStep {
  shardId: string;
  /** Partition block index — the posted order. */
  index: number;
  taskIds: string[];
  /** Union of the member tasks' PlanTaskSchema.requiredCapabilities (Cap scoring input). */
  requiredCapabilities: string[];
  /** Upstream shard ids from plan dependsOn ONLY — the execution readiness gate. */
  dependsOn: string[];
}

export interface ShardDag {
  planId: string;
  cycle: number;
  /** Steps in posted (partition index) order. */
  steps: ShardStep[];
  edges: ShardDagEdge[];
  /** Contract edges skipped because dependsOn already ordered the pair or a cycle would result. */
  skippedContractEdges: number;
  /** True when task-level dependsOn formed a cycle — ranks are undefined; callers fall back. */
  cyclic: boolean;
}

/** Kahn topological order over the DAG; null when a cycle exists. */
function topologicalOrder(dag: ShardDag): string[] | null {
  const indegree = new Map<string, number>(dag.steps.map((step) => [step.shardId, 0]));
  for (const edge of dag.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  // Ready set processed in posted order — deterministic tie-breaking.
  const order: string[] = [];
  const ready = dag.steps.filter((step) => (indegree.get(step.shardId) ?? 0) === 0).map((step) => step.shardId);
  const successors = new Map<string, string[]>();
  for (const edge of dag.edges) {
    const list = successors.get(edge.from) ?? [];
    list.push(edge.to);
    successors.set(edge.from, list);
  }
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const succ of successors.get(next) ?? []) {
      const remaining = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, remaining);
      if (remaining === 0) {
        // Insert keeping posted order (steps are index-sorted).
        const succIndex = dag.steps.find((step) => step.shardId === succ)!.index;
        let at = ready.findIndex((id) => dag.steps.find((step) => step.shardId === id)!.index > succIndex);
        if (at < 0) at = ready.length;
        ready.splice(at, 0, succ);
      }
    }
  }
  return order.length === dag.steps.length ? order : null;
}

/**
 * Builds the shard DAG (§6.4): vertices are shards; edges come from (a)
 * task-level dependsOn of the typed plan, mapped through shard membership,
 * and (b) cross-shard contracts (the cut's inter-shard edges), oriented by
 * partition order since the symmetrized cut carries no import direction.
 * A task whose allowlist straddles the cut belongs to several shards; its
 * scheduling home is the LOWEST-index one (documented v1 rule).
 */
export function buildShardDag(plan: ShardPlan): ShardDag {
  const shards = [...plan.shards].sort((a, b) => a.index - b.index);
  const taskToShard = new Map<string, string>();
  for (const shard of shards) {
    for (const taskId of shard.taskIds) {
      if (!taskToShard.has(taskId)) taskToShard.set(taskId, shard.id);
    }
  }

  const steps: ShardStep[] = shards.map((shard) => ({
    shardId: shard.id,
    index: shard.index,
    taskIds: [...shard.taskIds].sort(),
    requiredCapabilities: [
      ...new Set(
        shard.taskIds.flatMap((taskId) => plan.tasks.find((task) => task.id === taskId)?.requiredCapabilities ?? []),
      ),
    ].sort(),
    dependsOn: [],
  }));
  const stepById = new Map(steps.map((step) => [step.shardId, step]));
  const edges: ShardDagEdge[] = [];
  const edgeKeys = new Set<string>();

  // (a) Task-level dependsOn → shard-level order edges (weight 0: no seam).
  for (const task of plan.tasks) {
    const downstreamShardId = taskToShard.get(task.id);
    if (!downstreamShardId) continue;
    for (const dependencyId of task.dependsOn) {
      const upstreamShardId = taskToShard.get(dependencyId);
      if (!upstreamShardId || upstreamShardId === downstreamShardId) continue;
      const key = `${upstreamShardId}|${downstreamShardId}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: upstreamShardId, to: downstreamShardId, contractWeight: 0, kind: "dependsOn" });
    }
  }

  const reachable = (from: string, to: string): boolean => {
    const successors = new Map<string, string[]>();
    for (const edge of edges) {
      const list = successors.get(edge.from) ?? [];
      list.push(edge.to);
      successors.set(edge.from, list);
    }
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(successors.get(current) ?? []));
    }
    return false;
  };

  // (b) Cross-shard contracts → hand-off weight on shard-level edges.
  // Contracts list each cut edge on BOTH incident shards, so dedupe by the
  // unordered file pair, then attribute weight to the UNORDERED shard pair.
  // When dependsOn already orders the pair, the weight merges onto that edge
  // (a dependency crossing a seam still pays the hand-off, classic HEFT c̄);
  // otherwise the contract becomes its own edge, oriented by partition order
  // (documented — the symmetrized cut has no import direction).
  let skippedContractEdges = 0;
  const fileToShard = new Map<string, string>();
  for (const shard of shards) {
    for (const file of shard.files) {
      if (!fileToShard.has(file)) fileToShard.set(file, shard.id);
    }
  }
  const pairWeights = new Map<string, { a: string; b: string; weight: number }>();
  const seenFilePairs = new Set<string>();
  for (const shard of shards) {
    for (const contract of shard.crossShardContracts) {
      const fileKey = [contract.from, contract.to].sort().join("|");
      if (seenFilePairs.has(fileKey)) continue;
      seenFilePairs.add(fileKey);
      const fromShard = fileToShard.get(contract.from);
      const toShard = fileToShard.get(contract.to);
      if (!fromShard || !toShard || fromShard === toShard) continue;
      const [a, b] = [fromShard, toShard].sort();
      const pairKey = `${a}|${b}`;
      const pair = pairWeights.get(pairKey) ?? { a, b, weight: 0 };
      pair.weight += contract.weight;
      pairWeights.set(pairKey, pair);
    }
  }
  const edgeByKey = new Map(edges.map((edge) => [`${edge.from}|${edge.to}`, edge]));
  for (const pair of [...pairWeights.values()].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b))) {
    const existing = edgeByKey.get(`${pair.a}|${pair.b}`) ?? edgeByKey.get(`${pair.b}|${pair.a}`);
    if (existing) {
      existing.contractWeight += pair.weight; // Merge: dependsOn direction is authoritative.
      continue;
    }
    const [upstream, downstream] = (stepById.get(pair.a)!.index <= stepById.get(pair.b)!.index)
      ? [pair.a, pair.b]
      : [pair.b, pair.a];
    if (reachable(downstream, upstream)) {
      skippedContractEdges += 1; // Would cycle the DAG; the contract still gates at merge time (C4).
      continue;
    }
    const key = `${upstream}|${downstream}`;
    edgeKeys.add(key);
    const edge = { from: upstream, to: downstream, contractWeight: pair.weight, kind: "contract" as const };
    edges.push(edge);
    edgeByKey.set(key, edge);
  }

  // The readiness gate reads plan dependsOn ONLY (C3-ADV-005): contract-only
  // edges stay rank/hand-off inputs and never constrain execution order.
  for (const edge of edges) {
    if (edge.kind === "dependsOn") stepById.get(edge.to)!.dependsOn.push(edge.from);
  }
  for (const step of steps) step.dependsOn.sort();

  const dag: ShardDag = {
    planId: plan.id,
    cycle: plan.cycle,
    steps,
    edges,
    skippedContractEdges,
    cyclic: false,
  };
  dag.cyclic = topologicalOrder(dag) === null;
  return dag;
}

// ── Telemetry-calibrated cost model (§6.4 honesty constraint) ────────

/** Total measured tokens of one persisted run — the execution-cost unit. */
function usageTokens(usage: SubagentUsageCounters): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Telemetry hygiene (C3-ADV-006): a record with non-finite or negative
 * counters is poisoned input — one input:-1e9 record would drag a role mean
 * negative and invert critical-path-first. Skip it, never clamp-invent.
 */
function usableUsage(usage: SubagentUsageCounters): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, usage.turns]
    .every((value) => Number.isFinite(value) && value >= 0);
}

export interface RoleCostEstimate {
  samples: number;
  meanTokens: number;
  meanTurns: number;
}

export interface CostModel {
  source: "telemetry";
  /** Completed subagent runs the model is calibrated from. */
  samples: number;
  perRole: Record<string, RoleCostEstimate>;
  /** Mean execution tokens across all samples — the w̄ fallback for unobserved roles. */
  globalMeanTokens: number;
  /**
   * Measured hand-off cost per contract-weight unit (c̄ calibration):
   * mean OUTPUT tokens per sample — the empirical artifact-emission size.
   * A cross-shard contract of weight k means k references cross the seam;
   * expected chatter scales with k times the measured output size.
   */
  handoffPerUnit: number;
}

/**
 * Calibrates the cost model from the empirical usage distributions persisted
 * with subagent_finished events (state.swarm.tasks, rebuilt by replay).
 * Returns null when NO completed run carries usage — the refusal that §8.6's
 * headline gate asserts: never substitute a hard-coded cost table. Records
 * with non-finite/negative counters are skipped (C3-ADV-006).
 */
export function buildCostModel(records: SubagentTaskRecord[]): CostModel | null {
  const usable = records.filter((record) => {
    if (record.status !== "completed" || record.usage === null) return false;
    if (usableUsage(record.usage)) return true;
    log(`skipping poisoned usage record for task ${record.taskId} (non-finite or negative counters)`);
    return false;
  });
  if (usable.length === 0) return null;
  const perRole: Record<string, RoleCostEstimate> = {};
  let totalTokens = 0;
  let totalOutput = 0;
  for (const record of usable) {
    const usage = record.usage!;
    const tokens = usageTokens(usage);
    totalTokens += tokens;
    totalOutput += usage.output;
    const role = perRole[record.role] ?? { samples: 0, meanTokens: 0, meanTurns: 0 };
    role.meanTokens = (role.meanTokens * role.samples + tokens) / (role.samples + 1);
    role.meanTurns = (role.meanTurns * role.samples + usage.turns) / (role.samples + 1);
    role.samples += 1;
    perRole[record.role] = role;
  }
  return {
    source: "telemetry",
    samples: usable.length,
    perRole,
    globalMeanTokens: totalTokens / usable.length,
    handoffPerUnit: totalOutput / usable.length,
  };
}

/** Mean execution cost w̄_i: per-role estimate, global mean for unobserved roles (still telemetry-derived). */
function meanExecutionCost(role: AgentRole, costModel: CostModel): number {
  return costModel.perRole[role]?.meanTokens ?? costModel.globalMeanTokens;
}

// ── HEFT upward ranks (§6.4) ─────────────────────────────────────────

/**
 * rank_up(n_i) = w̄_i + max over successors n_j of (c̄_{i,j} + rank_up(n_j)),
 * computed backward from the exit steps; c̄_{i,j} = contractWeight × measured
 * handoffPerUnit. REQUIRES a telemetry cost model — callers with no telemetry
 * take the conservative fallback instead of scheduling on invented numbers.
 */
export function computeUpwardRanks(dag: ShardDag, costModel: CostModel, role: AgentRole = "Implementer"): Map<string, number> {
  const order = topologicalOrder(dag);
  if (!order) throw new Error(`shard DAG ${dag.planId} is cyclic — ranks are undefined`);
  const ranks = new Map<string, number>();
  const successors = new Map<string, ShardDagEdge[]>();
  for (const edge of dag.edges) {
    const list = successors.get(edge.from) ?? [];
    list.push(edge);
    successors.set(edge.from, list);
  }
  for (const shardId of [...order].reverse()) {
    let rank = meanExecutionCost(role, costModel);
    let bestSuccessor = 0;
    for (const edge of (successors.get(shardId) ?? []).slice().sort((a, b) => a.to.localeCompare(b.to))) {
      const candidate = edge.contractWeight * costModel.handoffPerUnit + ranks.get(edge.to)!;
      if (candidate > bestSuccessor) bestSuccessor = candidate;
    }
    rank += bestSuccessor;
    ranks.set(shardId, rank);
  }
  return ranks;
}

// ── Worker candidates + bounded contract-net bidding (§6.5) ──────────

export interface WorkerCandidate {
  /** Concurrency slot on the long-lived pool. */
  slot: number;
  /** Capabilities the worker can satisfy (homogeneous v1: the dispatch role profile's permittedEffects). */
  capabilities: string[];
}

/** Homogeneous v1 candidates: every slot of the pool advertises the dispatch role's permittedEffects. */
function poolWorkerCandidates(concurrency: number, role: AgentRole = "Implementer"): WorkerCandidate[] {
  const profile = getRoleProfile(role);
  return Array.from({ length: concurrency }, (_, slot) => ({
    slot,
    capabilities: [...profile.permittedEffects],
  }));
}

/**
 * The announcement shortlist (§6.5 bounded fan-out): announcements go to a
 * TARGETED subset — workers whose capability set best matches the step's
 * requiredCapabilities — never a broadcast. Size never exceeds the pool's
 * concurrency cap. Full capability matches win; with none, the best partial
 * matches are kept (satisficing — documented §6.5 evidence: local bids are a
 * heuristic layer under the periodic global critic).
 */
export function buildShortlist(step: ShardStep, candidates: WorkerCandidate[], cap: number): WorkerCandidate[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    matched: step.requiredCapabilities.filter((capability) => candidate.capabilities.includes(capability)).length,
  }));
  const full = scored.filter((entry) => entry.matched === step.requiredCapabilities.length);
  const pool = full.length > 0 ? full : scored;
  return pool
    .sort((a, b) => b.matched - a.matched || a.candidate.slot - b.candidate.slot)
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.candidate);
}

export interface Bid {
  slot: number;
  /** Cap_{i,j}: fraction of requiredCapabilities satisfied (1 when none required). */
  capabilityScore: number;
  /** Cost_{i,j}: telemetry-estimated finish time (EFT) of the step on this worker, in tokens. */
  costTokens: number;
  /** α·Cap − β·(Cost/globalMeanTokens) — dimensionless cost ratio keeps the dials comparable. */
  utility: number;
  est: number;
  eft: number;
}

/**
 * Bids for one step against its shortlist. Bid cost IS the EFT on that
 * worker (§6.4 placement formula inside the §6.5 protocol):
 *   EST(i,k) = max(slotReady_k, max over placed preds p of (AFT_p + c̄_{p,i} when p is off-slot k))
 *   EFT      = EST + w̄_i
 * Award = argmax utility; ties break to the lower EFT, then the lower slot —
 * in the homogeneous full-capability case this reduces to classic HEFT
 * earliest-finish-time placement.
 */
export function solicitBids(
  step: ShardStep,
  shortlist: WorkerCandidate[],
  dag: ShardDag,
  placed: Map<string, { slot: number; eft: number }>,
  slotReady: number[],
  costModel: CostModel,
  config: Pick<SchedulerConfig, "alpha" | "beta">,
  role: AgentRole = "Implementer",
): Bid[] {
  const inbound = dag.edges.filter((edge) => edge.to === step.shardId);
  return shortlist.map((candidate) => {
    let depReady = 0;
    for (const edge of inbound) {
      const predecessor = placed.get(edge.from);
      if (!predecessor) continue; // List order places predecessors first; guard anyway.
      const handoff = predecessor.slot === candidate.slot ? 0 : edge.contractWeight * costModel.handoffPerUnit;
      depReady = Math.max(depReady, predecessor.eft + handoff);
    }
    const est = Math.max(slotReady[candidate.slot] ?? 0, depReady);
    const eft = est + meanExecutionCost(role, costModel);
    const capabilityScore = step.requiredCapabilities.length === 0
      ? 1
      : step.requiredCapabilities.filter((capability) => candidate.capabilities.includes(capability)).length
        / step.requiredCapabilities.length;
    return {
      slot: candidate.slot,
      capabilityScore,
      costTokens: eft,
      utility: config.alpha * capabilityScore - config.beta * (eft / Math.max(1, costModel.globalMeanTokens)),
      est,
      eft,
    };
  });
}

/** Award = argmax utility over the shortlist bids (Σ_i x_{i,j} = 1: exactly one winner per step). */
export function awardBid(bids: Bid[]): Bid {
  return [...bids].sort((a, b) => b.utility - a.utility || a.eft - b.eft || a.slot - b.slot)[0];
}

// ── Schedules ────────────────────────────────────────────────────────

export type ScheduleStrategy = "heft" | "conservative_fallback" | "posted_order";

export interface ScheduledStep {
  shardId: string;
  /** Null under conservative_fallback / posted_order: no ranks without telemetry. */
  rank: number | null;
  slot: number | null;
  est: number | null;
  eft: number | null;
  shortlistSize: number;
  /** Diagnostic-only (C3-OUS-007): the award audit trail for tests/logs — persisted nowhere, never consumed downstream. */
  bids: Bid[];
}

export interface ShardSchedule {
  planId: string;
  cycle: number;
  strategy: ScheduleStrategy;
  costSource: "telemetry" | "none";
  /** Scheduling order: critical-path-first under HEFT; readiness order otherwise. */
  order: string[];
  steps: ScheduledStep[];
  reason: string;
}

function stepEntry(shardId: string, partial: Partial<ScheduledStep> = {}): ScheduledStep {
  return { shardId, rank: null, slot: null, est: null, eft: null, shortlistSize: 0, bids: [], ...partial };
}

/**
 * The conservative default-concurrency placement (§8.6): readiness-based
 * topological order, NO ranks, NO timed placements — the documented answer
 * when there is no telemetry to calibrate from. Inventing a cost table here
 * would import exactly the static-estimate fragility §7.2 warns about.
 */
function conservativeFallbackSchedule(plan: ShardPlan, dag: ShardDag, reason: string): ShardSchedule {
  const order = topologicalOrder(dag) ?? dag.steps.map((step) => step.shardId);
  return {
    planId: plan.id,
    cycle: plan.cycle,
    strategy: "conservative_fallback",
    costSource: "none",
    order,
    steps: dag.steps.map((step) => stepEntry(step.shardId)),
    reason,
  };
}

/** Rollback path (§8.6): plain posted order — AgentPool.map-at-default-concurrency semantics. */
function postedOrderSchedule(plan: ShardPlan): ShardSchedule {
  const dag = buildShardDag(plan);
  return {
    planId: plan.id,
    cycle: plan.cycle,
    strategy: "posted_order",
    costSource: "none",
    order: dag.steps.map((step) => step.shardId),
    steps: dag.steps.map((step) => stepEntry(step.shardId)),
    reason: "scheduler bypassed by flag — shard steps execute in posted order at default concurrency (§8.6 rollback)",
  };
}

export interface ScheduleOptions {
  costModel: CostModel | null;
  config: SchedulerConfig;
  role?: AgentRole;
  candidates?: WorkerCandidate[];
}

/**
 * HEFT schedule over the shard DAG: upward ranks (critical path first),
 * EFT placement via bounded contract-net bidding. Falls back — never to a
 * hard-coded cost table — when telemetry or DAG acyclicity is missing.
 */
export function scheduleShardPlan(plan: ShardPlan, options: ScheduleOptions): ShardSchedule {
  const { costModel, config } = options;
  const role = options.role ?? "Implementer";
  const dag = buildShardDag(plan);

  if (dag.cyclic) {
    return conservativeFallbackSchedule(plan, dag,
      "task-level dependsOn forms a cycle — ranks undefined; conservative readiness order at default concurrency");
  }
  if (!costModel) {
    return conservativeFallbackSchedule(plan, dag,
      "no telemetry samples persisted with subagent_finished — refusing any hard-coded cost table (§6.4/§8.6)");
  }
  // C3-ADV-003: too-thin telemetry for the dispatch role is no calibration.
  const roleSamples = costModel.perRole[role]?.samples ?? 0;
  if (roleSamples < MIN_COST_SAMPLES) {
    return conservativeFallbackSchedule(plan, dag,
      `only ${roleSamples} completed-with-usage sample(s) for dispatch role ${role} (< ${MIN_COST_SAMPLES}) — telemetry too thin to calibrate HEFT, conservative readiness order`);
  }
  // C3-ADV-010: an empty candidate list means no worker can be announced to —
  // treat it exactly like missing telemetry, never awardBid([]) → TypeError.
  const candidates = options.candidates ?? poolWorkerCandidates(config.concurrency, role);
  if (candidates.length === 0) {
    return conservativeFallbackSchedule(plan, dag,
      "no worker candidates to announce to — conservative readiness order at default concurrency");
  }

  const ranks = computeUpwardRanks(dag, costModel, role);
  // Critical path first: decreasing rank; ties keep posted order.
  const order = [...dag.steps]
    .sort((a, b) => ranks.get(b.shardId)! - ranks.get(a.shardId)! || a.index - b.index)
    .map((step) => step.shardId);

  const placed = new Map<string, { slot: number; eft: number }>();
  const slotReady = new Array<number>(config.concurrency).fill(0);
  const stepById = new Map(dag.steps.map((step) => [step.shardId, step]));
  const steps: ScheduledStep[] = [];
  for (const shardId of order) {
    const step = stepById.get(shardId)!;
    const shortlist = buildShortlist(step, candidates, config.concurrency);
    if (shortlist.length === 0) {
      // Defensive (unreachable with candidates ≥ 1 and cap ≥ 1): same refusal.
      return conservativeFallbackSchedule(plan, dag,
        `step ${shardId} drew an empty announcement shortlist — conservative readiness order`);
    }
    const bids = solicitBids(step, shortlist, dag, placed, slotReady, costModel, config, role);
    const winner = awardBid(bids);
    placed.set(shardId, { slot: winner.slot, eft: winner.eft });
    slotReady[winner.slot] = Math.max(slotReady[winner.slot] ?? 0, winner.eft);
    steps.push(stepEntry(shardId, {
      rank: ranks.get(shardId)!,
      slot: winner.slot,
      est: winner.est,
      eft: winner.eft,
      shortlistSize: shortlist.length,
      bids,
    }));
  }

  return {
    planId: plan.id,
    cycle: plan.cycle,
    strategy: "heft",
    costSource: "telemetry",
    order,
    steps,
    reason: `HEFT over ${dag.steps.length} shard steps, telemetry-calibrated from ${costModel.samples} sample(s)`,
  };
}

// ── Telemetry drift + periodic global re-plan (§6.4/§6.5) ────────────

export interface DriftReport {
  drifted: boolean;
  /** Max relative per-role mean-cost deviation vs the baseline model. */
  maxDeviation: number;
  threshold: number;
  perRole: Record<string, number>;
  /** False when no fresh telemetry exists — no new information is not drift. */
  hasFreshTelemetry: boolean;
}

/**
 * Drift = max over roles present in the baseline of |fresh − baseline| /
 * baseline mean tokens. Roles absent from the baseline are new information,
 * not drift. A baseline role with zero mean counts any fresh mass as full
 * deviation (1.0).
 */
export function detectTelemetryDrift(
  baseline: CostModel,
  records: SubagentTaskRecord[],
  threshold: number,
): DriftReport {
  const fresh = buildCostModel(records);
  if (!fresh) {
    return { drifted: false, maxDeviation: 0, threshold, perRole: {}, hasFreshTelemetry: false };
  }
  const perRole: Record<string, number> = {};
  let maxDeviation = 0;
  for (const [role, estimate] of Object.entries(baseline.perRole)) {
    const freshEstimate = fresh.perRole[role];
    if (!freshEstimate) continue;
    const deviation = estimate.meanTokens === 0
      ? (freshEstimate.meanTokens === 0 ? 0 : 1)
      : Math.abs(freshEstimate.meanTokens - estimate.meanTokens) / estimate.meanTokens;
    perRole[role] = deviation;
    maxDeviation = Math.max(maxDeviation, deviation);
  }
  return { drifted: maxDeviation > threshold, maxDeviation, threshold, perRole, hasFreshTelemetry: true };
}

/** Cadence guard (§6.5 "periodic"): re-plan at most once per replanIntervalMs, drift or not. */
export function shouldReplan(lastReplanAtMs: number, nowMs: number, config: Pick<SchedulerConfig, "replanIntervalMs">): boolean {
  return nowMs - lastReplanAtMs >= config.replanIntervalMs;
}

/**
 * The §6.5 periodic global critic: re-runs the global HEFT view with the
 * recalibrated cost model and reassigns UNSTARTED work only. Started steps
 * are cloned verbatim from the previous schedule — never re-ranked, never
 * re-placed — because their awards are already ledgered (shard_claimed).
 * Applies to HEFT schedules only; a fallback/posted-order schedule carries
 * no ranks to refresh, so it is returned unchanged.
 */
export function replanUnstarted(
  previous: ShardSchedule,
  plan: ShardPlan,
  startedShardIds: ReadonlySet<string>,
  costModel: CostModel,
  config: SchedulerConfig,
  options: { role?: AgentRole; candidates?: WorkerCandidate[] } = {},
): ShardSchedule {
  if (previous.strategy !== "heft") return previous;
  const role = options.role ?? "Implementer";
  const dag = buildShardDag(plan);
  if (dag.cyclic) return previous;
  // Never re-plan onto less information (C3-ADV-003/C3-ADV-010): too-thin
  // role telemetry or an empty candidate list keeps the previous schedule.
  if ((costModel.perRole[role]?.samples ?? 0) < MIN_COST_SAMPLES) return previous;
  const candidates = options.candidates ?? poolWorkerCandidates(config.concurrency, role);
  if (candidates.length === 0) {
    log("re-plan skipped: no worker candidates to announce to");
    return previous;
  }
  const ranks = computeUpwardRanks(dag, costModel, role);

  // Seed placement state from the started steps' RECORDED awards.
  const placed = new Map<string, { slot: number; eft: number }>();
  const slotReady = new Array<number>(config.concurrency).fill(0);
  const startedSteps: ScheduledStep[] = [];
  for (const step of previous.steps) {
    if (!startedShardIds.has(step.shardId)) continue;
    startedSteps.push({ ...step });
    if (step.slot !== null && step.eft !== null) {
      placed.set(step.shardId, { slot: step.slot, eft: step.eft });
      slotReady[step.slot] = Math.max(slotReady[step.slot] ?? 0, step.eft);
    }
  }

  const stepById = new Map(dag.steps.map((step) => [step.shardId, step]));
  const unstartedOrder = dag.steps
    .filter((step) => !startedShardIds.has(step.shardId))
    .sort((a, b) => ranks.get(b.shardId)! - ranks.get(a.shardId)! || a.index - b.index)
    .map((step) => step.shardId);

  const replannedSteps: ScheduledStep[] = [];
  for (const shardId of unstartedOrder) {
    const step = stepById.get(shardId)!;
    const shortlist = buildShortlist(step, candidates, config.concurrency);
    const bids = solicitBids(step, shortlist, dag, placed, slotReady, costModel, config, role);
    const winner = awardBid(bids);
    placed.set(shardId, { slot: winner.slot, eft: winner.eft });
    slotReady[winner.slot] = Math.max(slotReady[winner.slot] ?? 0, winner.eft);
    replannedSteps.push(stepEntry(shardId, {
      rank: ranks.get(shardId)!,
      slot: winner.slot,
      est: winner.est,
      eft: winner.eft,
      shortlistSize: shortlist.length,
      bids,
    }));
  }

  return {
    planId: previous.planId,
    cycle: previous.cycle,
    strategy: "heft",
    costSource: "telemetry",
    order: [...previous.order.filter((shardId) => startedShardIds.has(shardId)), ...unstartedOrder],
    steps: [...startedSteps, ...replannedSteps],
    reason: `global re-plan on telemetry drift — ${startedSteps.length} started step(s) frozen, ${replannedSteps.length} unstarted re-ranked`,
  };
}

// ── Error-cascade ledger monitor (§7.3 blackboard safeguard) ─────────

export interface CascadeSignature {
  failedShardId: string;
  /** Downstream steps that consumed the failed shard's output with no intervening verification. */
  consumers: string[];
  failedAt: string | null;
  detectedAt: string | null;
  sequence: number | null;
}

/**
 * Watches the ledger (the blackboard) for its principal failure surface
 * (§7.3): a failed shard's output consumed by TWO OR MORE downstream steps
 * without an intervening verification event. "Verification" in the v1 event
 * vocabulary is a shard_completed for the failed shard (a successful repair
 * re-run); merge_verified (C4) is accepted forward-compatibly and simply
 * never appears yet. One signature is emitted per failure episode, at the
 * moment the second distinct consumer is claimed.
 *
 * Scoping (C3-ADV-004): episodes and consumer matching are keyed on the
 * DAG's (planId, cycle) — a run can ledger several shard plans across
 * cycles, and unfiltered events would let cycle-2 claims feed a cycle-1
 * episode. PRECONDITION: events carry planId/cycle (the v1 shard_* ledger
 * shape); events without them, or from other plans/cycles, are skipped.
 * PRODUCTION CALLER: executeShardPlan (C3-OUS-006).
 */
export function detectErrorCascadeSignatures(
  events: Array<Record<string, unknown>>,
  dag: ShardDag,
): CascadeSignature[] {
  const successors = new Map<string, Set<string>>();
  for (const edge of dag.edges) {
    const set = successors.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    successors.set(edge.from, set);
  }
  const open = new Map<string, { consumers: Set<string>; flagged: boolean; failedAt: string | null }>();
  const signatures: CascadeSignature[] = [];
  for (const event of events) {
    const shardId = typeof event.shardId === "string" ? event.shardId : null;
    if (!shardId) continue;
    if (event.planId !== dag.planId || event.cycle !== dag.cycle) continue; // Not this DAG's episode.
    if (event.type === "shard_failed") {
      open.set(shardId, {
        consumers: new Set(),
        flagged: false,
        failedAt: typeof event.timestamp === "string" ? event.timestamp : null,
      });
      continue;
    }
    if (event.type === "shard_completed" || event.type === "merge_verified") {
      open.delete(shardId); // Intervening verification heals the episode.
      continue;
    }
    if (event.type !== "shard_claimed") continue;
    for (const [failedShardId, episode] of open) {
      if (!successors.get(failedShardId)?.has(shardId)) continue;
      episode.consumers.add(shardId);
      if (!episode.flagged && episode.consumers.size >= 2) {
        episode.flagged = true;
        signatures.push({
          failedShardId,
          consumers: [...episode.consumers].sort(),
          failedAt: episode.failedAt,
          detectedAt: typeof event.timestamp === "string" ? event.timestamp : null,
          sequence: typeof event.sequence === "number" ? event.sequence : null,
        });
      }
    }
  }
  return signatures;
}

// ── Executor: dispatch through dispatchAgentTask (C1 contract) ───────

// The dispatch task-id convention lives in src/domain/shard.js
// (shardDispatchTaskId) — re-exported here for scheduler consumers.
export { shardDispatchTaskId } from "../domain/shard.js";

export interface ShardExecutionDeps {
  stateManager: StateManagerAPI;
  /** The long-lived run pool (C1 registry owns its lifecycle). */
  pool: AgentPool;
  /** Broker gate — dispatch wraps pool.submit through it (C1 extraction; not re-implemented here). */
  broker: CapabilityBroker;
  cwd: string;
  backend: string;
  detectedBackend: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to loadSchedulerConfig(cwd). */
  config?: SchedulerConfig;
  role?: AgentRole;
  candidates?: WorkerCandidate[];
  now?: () => number;
  log?: (message: string) => void;
}

export interface ShardExecutionReport {
  planId: string;
  strategy: ScheduleStrategy;
  schedulerEnabled: boolean;
  /** Shard ids in the order claims were ledgered. */
  claimOrder: string[];
  completed: string[];
  failed: string[];
  /** Dependents left unclaimed because an upstream shard failed (readiness-gated strategies). */
  blocked: string[];
  replans: number;
  /** Post-execution scan of the run ledger by the error-cascade monitor (its production caller). */
  cascadeSignatures: CascadeSignature[];
  outcomes: DispatchOutcome[];
}

const PROCESS_RESTART_ERROR = "process_restart";

/**
 * A shard dispatch id is stable for its first episode and unique for every
 * crash-recovery episode. Reusing the first id would append a second
 * subagent_started record that recordSubagentFinished could not distinguish
 * from the already-failed task. Both task and claim ledgers count as used:
 * shard_claimed can survive the narrow pre-subagent_started crash window.
 */
function nextShardDispatchTaskId(
  state: IterativeGoalState,
  cycle: number,
  shardId: string,
): string {
  const base = shardDispatchTaskId(cycle, shardId);
  const used = new Set([
    ...state.swarm.tasks.map((task) => task.taskId),
    ...state.shards.claims
      .map((claim) => claim.taskId)
      .filter((taskId): taskId is string => typeof taskId === "string"),
  ]);
  if (!used.has(base)) return base;
  for (let episode = 2; ; episode += 1) {
    const candidate = `${base}-retry-${episode}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Executes a shard plan: builds the schedule (HEFT when the flag is on and
 * telemetry exists; conservative fallback when not; plain posted order when
 * the flag is off), then dispatches steps through dispatchAgentTask — the
 * broker-gated, ledger-wrapped C1 primitive — claiming each award as
 * shard_claimed and settling it as shard_completed / shard_failed.
 *
 * Readiness gating applies under heft / conservative_fallback (a failed
 * upstream blocks its dependents); the posted_order rollback deliberately
 * keeps AgentPool.map semantics — posted order at default concurrency, no
 * dependency gating — so C2 output executes exactly as before C3.
 */
export async function executeShardPlan(plan: ShardPlan, deps: ShardExecutionDeps): Promise<ShardExecutionReport> {
  const config = deps.config ?? loadSchedulerConfig(deps.cwd);
  const role = deps.role ?? "Implementer";
  const now = deps.now ?? (() => Date.now());
  const state = deps.stateManager.getState();
  if (!state) throw new Error("executeShardPlan requires an active run");
  const runId = state.runId;
  if (config.workerModelProfile !== null) {
    // Validate before recording a defensive plan, claim, or worker event.
    // The pool repeats this gate while materializing the selected provider,
    // but that later check cannot prevent ledger pollution on bad config.
    requireModelRoute(config.workerModelProfile);
  }
  // Ledger coherence: every claim references this planId, so the plan must be
  // on the ledger for replay to rebuild shard state and the shards d/t field.
  // In production the C2 hook posts it at the plan→implement transition;
  // record defensively for out-of-band invocation (keyed on id+cycle+runId).
  if (!state.shards.plans.some((posted) => posted.id === plan.id && posted.cycle === plan.cycle && posted.runId === plan.runId)) {
    deps.stateManager.recordShardPlan(plan);
  }
  const dag = buildShardDag(plan);
  const telemetry = () => deps.stateManager.getState()?.swarm.tasks ?? [];

  let schedule: ShardSchedule;
  if (!config.enabled) {
    schedule = postedOrderSchedule(plan);
  } else {
    schedule = scheduleShardPlan(plan, { costModel: buildCostModel(telemetry()), config, role, candidates: deps.candidates });
  }
  deps.log?.(`Scheduler: ${schedule.strategy} — ${schedule.reason}`);

  const batchId = `sched-${plan.id}-c${plan.cycle}`;
  const readinessGated = schedule.strategy !== "posted_order";
  const stepById = new Map(dag.steps.map((step) => [step.shardId, step]));
  const scheduledById = new Map(schedule.steps.map((step) => [step.shardId, step]));
  const startedShardIds = new Set<string>();
  const completedShardIds = new Set<string>();
  const failedShardIds = new Set<string>();
  const blockedShardIds = new Set<string>();
  const claimOrder: string[] = [];
  const outcomes: DispatchOutcome[] = [];
  let replans = 0;
  let failureSinceReplan = false;
  let activeCostModel = buildCostModel(telemetry());
  let lastReplanAt = now();

  // Resume from the latest replayed claim episode for this exact plan cycle.
  // Completed work satisfies dependencies and is never repeated. Genuine
  // failures stay terminal. Only unclaimed work and process_restart failures
  // enter this execution's pending set.
  const priorClaims = new Map(
    state.shards.claims
      .filter((claim) => claim.planId === plan.id && claim.cycle === plan.cycle)
      .map((claim) => [claim.shardId, claim]),
  );
  for (const [shardId, claim] of priorClaims) {
    if (!stepById.has(shardId)) continue;
    if (claim.status === "completed") {
      completedShardIds.add(shardId);
      startedShardIds.add(shardId);
    } else if (claim.status === "failed" && claim.error !== PROCESS_RESTART_ERROR) {
      failedShardIds.add(shardId);
      startedShardIds.add(shardId);
    } else if (claim.status === "claimed") {
      // A live or C4 repair-loop claim is not ours to duplicate. Production
      // restore converts dispatched taskId-bearing claims to process_restart;
      // taskId:null remains held for the merge repair path.
      startedShardIds.add(shardId);
    }
  }
  const pending = new Set(schedule.order.filter((shardId) => {
    const claim = priorClaims.get(shardId);
    return !claim || (claim.status === "failed" && claim.error === PROCESS_RESTART_ERROR);
  }));
  const inFlight = new Map<string, Promise<void>>();
  let order = [...schedule.order];

  const dispatchShard = async (shardId: string): Promise<void> => {
    const shard = plan.shards.find((item) => item.id === shardId)!;
    const scheduled = scheduledById.get(shardId);
    // Slots come from the HEFT placement only; fallback/posted-order runs do
    // not pre-assign slots (workers are dynamic), so the claim records null.
    const slot = scheduled?.slot ?? null;
    try {
      const built = buildAgentTaskFromProfile({
        id: nextShardDispatchTaskId(deps.stateManager.getState()!, plan.cycle, shardId),
        role,
        // checks[].command is ledger-scrubbed UNTRUSTED_DATA and INERT — never
        // rendered into the prompt, never executed (C3 contract note).
        task: [
          `Implement shard ${shardId} of plan ${plan.id} (cycle ${plan.cycle}).`,
          `Write scope (do not edit outside these files): ${shard.files.join(", ")}.`,
          shard.taskIds.length > 0
            ? `Plan tasks: ${shard.taskIds.map((taskId) => plan.tasks.find((task) => task.id === taskId)?.title ?? taskId).join("; ")}.`
            : "No plan tasks mapped to this shard.",
          shard.crossShardContracts.length > 0
            ? `Cross-shard contracts (interfaces another shard also touches — keep them stable): ${shard.crossShardContracts.map((contract) => `${contract.from} ↔ ${contract.to}`).join("; ")}.`
            : "No cross-shard contracts.",
        ].join("\n"),
        allowedPaths: shard.allowedPaths.map(serializePathScope),
        model: config.workerModelProfile ?? undefined,
        inputArtifactIds: [],
      });
      if (!built.ok) throw new Error(built.error);
      const agentTask: AgentTask = built.task;
      deps.stateManager.recordShardClaimed({
        shardId,
        planId: plan.id,
        runId,
        cycle: plan.cycle,
        status: "claimed",
        workerSlot: slot,
        rank: scheduled?.rank ?? null,
        taskId: agentTask.id,
        claimedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        patchArtifactPath: null,
      }, {
        strategy: schedule.strategy,
        rank: scheduled?.rank ?? null,
        slot,
        est: scheduled?.est ?? null,
        eft: scheduled?.eft ?? null,
        shortlistSize: scheduled?.shortlistSize ?? 0,
      });
      startedShardIds.add(shardId);

      const outcome = await dispatchAgentTask({
        pool: deps.pool,
        broker: deps.broker,
        stateManager: deps.stateManager,
        runId,
        batchId,
        mode: "parallel",
        backend: deps.backend,
        detectedBackend: deps.detectedBackend,
        cwd: deps.cwd,
        signal: deps.signal,
      }, agentTask);
      outcomes.push(outcome);

      if (outcome.ok) {
        // C4-OUS-001: persist the captured patch bytes BEFORE settling, so a
        // crash between dispatch and merge-back never strands the work — the
        // claim carries the run-dir artifact path and a warm restart rebuilds
        // merge inputs from the ledger.
        const capturedPatch = outcome.result?.patch;
        // Persist even an exact empty patch. "" is a successful no-op while
        // null/undefined means capture failed; collapsing both to a null
        // artifact pointer makes a warm restart reject valid no-op work.
        const patchArtifactPath = typeof capturedPatch === "string"
          ? persistShardPatchArtifact(deps.stateManager, plan.cycle, shardId, capturedPatch, deps.cwd)
          : null;
        deps.stateManager.recordShardFinished(shardId, { runId, planId: plan.id, cycle: plan.cycle, status: "completed", taskId: agentTask.id, patchArtifactPath });
        completedShardIds.add(shardId);
      } else {
        deps.stateManager.recordShardFinished(shardId, {
          runId, planId: plan.id, cycle: plan.cycle, status: "failed", taskId: agentTask.id,
          error: outcome.policyError ?? outcome.result?.stderr ?? `status ${outcome.status}`,
        });
        failedShardIds.add(shardId);
        failureSinceReplan = true;
      }
    } catch (err) {
      // Exception containment (C3-ADV-011): a throw anywhere in the dispatch
      // body settles THIS shard as failed and cannot abort executeShardPlan
      // while siblings keep writing. Claim-then-fail when the throw preceded
      // the claim, so the ledger keeps the claimed→settled shape
      // (C3-ADV-008 — orphan settles are skipped by the record method).
      const message = err instanceof Error ? err.message : String(err);
      if (!startedShardIds.has(shardId)) {
        deps.stateManager.recordShardClaimed({
          shardId,
          planId: plan.id,
          runId,
          cycle: plan.cycle,
          status: "claimed",
          workerSlot: slot,
          rank: scheduled?.rank ?? null,
          taskId: null,
          claimedAt: new Date().toISOString(),
          finishedAt: null,
          error: null,
          patchArtifactPath: null,
        }, { strategy: schedule.strategy, rank: scheduled?.rank ?? null, slot, buildError: message });
        startedShardIds.add(shardId);
      }
      deps.stateManager.recordShardFinished(shardId, {
        runId, planId: plan.id, cycle: plan.cycle, status: "failed", error: message,
      });
      failedShardIds.add(shardId);
      failureSinceReplan = true;
      log(`shard ${shardId} settled failed via exception containment: ${message}`);
    }
  };

  // Readiness-driven list-scheduling loop over the static schedule: a freed
  // worker takes the highest-priority READY pending step. Bounded by
  // config.concurrency — the same cap that bounds the announcement shortlist.
  while (pending.size > 0 || inFlight.size > 0) {
    while (inFlight.size < config.concurrency) {
      const next = order.find((shardId) => {
        if (!pending.has(shardId)) return false;
        if (!readinessGated) return true;
        return (stepById.get(shardId)?.dependsOn ?? []).every((dep) => completedShardIds.has(dep));
      });
      if (!next) break;
      pending.delete(next);
      claimOrder.push(next);
      const promise = dispatchShard(next).finally(() => inFlight.delete(next));
      inFlight.set(next, promise);
    }
    if (inFlight.size === 0) {
      // No progress possible: everything left is blocked behind a failure.
      for (const shardId of pending) blockedShardIds.add(shardId);
      pending.clear();
      break;
    }
    await Promise.race(inFlight.values());

    // §6.5 periodic global critic, cadence-guarded. TWO triggers: telemetry
    // drift, or a shard failure since the last re-plan. Failures never enter
    // the cost model (buildCostModel filters completed-with-usage), so a
    // failure-triggered re-plan re-ranks UNSTARTED steps on the SAME model —
    // its value is reassigning unstarted work around the failure, not
    // recalibration. Dependents of the failed shard stay blocked (their
    // readiness never opens); started steps are never re-ranked.
    if (schedule.strategy === "heft" && activeCostModel && pending.size > 0) {
      const drift = detectTelemetryDrift(activeCostModel, telemetry(), config.driftThreshold);
      if ((drift.drifted || failureSinceReplan) && shouldReplan(lastReplanAt, now(), config)) {
        const trigger = drift.drifted ? `drift ${drift.maxDeviation.toFixed(3)} > ${config.driftThreshold}` : "shard failure";
        schedule = replanUnstarted(schedule, plan, startedShardIds,
          buildCostModel(telemetry()) ?? activeCostModel, config, { role, candidates: deps.candidates });
        activeCostModel = buildCostModel(telemetry()) ?? activeCostModel;
        lastReplanAt = now();
        failureSinceReplan = false;
        replans += 1;
        for (const step of schedule.steps) scheduledById.set(step.shardId, step);
        order = schedule.order;
        log(`re-plan #${replans} (${trigger}) — ${schedule.reason}`);
      }
    }
  }

  // §7.3 blackboard safeguard: the cascade monitor's production caller
  // (C3-OUS-006). Post-execution scan of the run ledger — the events this
  // execution just wrote are exactly the monitor's input.
  let cascadeSignatures: CascadeSignature[] = [];
  try {
    const events = fs
      .readFileSync(deps.stateManager.getEventsPath(), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    cascadeSignatures = detectErrorCascadeSignatures(events, dag);
  } catch (err) {
    // The monitor is an observer: its own failure must never fail execution.
    log(`cascade monitor scan skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const signature of cascadeSignatures) {
    deps.log?.(`ERROR-CASCADE SIGNATURE: shard ${signature.failedShardId} failed and its output was consumed by ${signature.consumers.length} downstream steps (${signature.consumers.join(", ")}) without an intervening verification event`);
  }

  return {
    planId: plan.id,
    strategy: schedule.strategy,
    schedulerEnabled: config.enabled,
    claimOrder,
    completed: [...completedShardIds].sort(),
    failed: [...failedShardIds].sort(),
    blocked: [...blockedShardIds].sort(),
    replans,
    cascadeSignatures,
    outcomes,
  };
}

// ── Lifecycle seam (§6.4–6.5, C3-ADV-001) ────────────────────────────

export interface SchedulerHookDeps {
  stateManager: StateManagerAPI;
  cwd: string;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to loadSchedulerConfig(cwd).enabled. */
  schedulerEnabled?: boolean;
  /**
   * Injectable for tests; defaults to the long-lived run pool from the C1
   * registry (getRunAgentPool), which a test can pre-register with a fake
   * pool — the same seam goal-swarm-cancel uses.
   */
  pool?: AgentPool;
  broker?: CapabilityBroker;
  backend?: string;
  detectedBackend?: string;
  signal?: AbortSignal;
}

/**
 * The scheduler hook at the exact plan→implement transition, called from
 * advanceToNextPhase right after runSharderHook (§6.4–6.5, C3-ADV-001).
 * Flag-gated: with the flag OFF it returns before touching anything, so
 * flag-off behavior is byte-identical to pre-C3. With the flag ON and a
 * fan_out shard plan on the ledger for the current cycle, the plan executes
 * through executeShardPlan (HEFT when telemetry suffices, conservative
 * fallback otherwise). Returns the execution report, or null when the hook
 * did not act. Exceptions propagate to the lifecycle call site's try/catch,
 * which degrades to the single-slice implement prompt.
 */
export async function runSchedulerHook(deps: SchedulerHookDeps): Promise<ShardExecutionReport | null> {
  const config = loadSchedulerConfig(deps.cwd);
  const enabled = deps.schedulerEnabled ?? config.enabled;
  if (!enabled) return null;

  const state = deps.stateManager.getState();
  if (!state || state.status !== "running") return null;
  const plan = [...state.shards.plans].reverse().find(
    (candidate) => candidate.cycle === state.cycle && candidate.decision === "fan_out" && candidate.shards.length > 0,
  );
  if (!plan) {
    log(`Scheduler enabled but no fan_out shard plan for cycle ${state.cycle}; implement continues single-slice`);
    return null;
  }
  const planClaims = state.shards.claims.filter(
    (claim) => claim.planId === plan.id && claim.cycle === plan.cycle,
  );
  // A claim that is still live (or taskId:null in C4's repair loop) is not
  // safe to duplicate. On a real restore, every dispatched taskId-bearing
  // claim is first reconciled to failed/process_restart by StateManager.
  if (planClaims.some((claim) => claim.status === "claimed")) {
    log(`Shard plan ${plan.id} cycle ${plan.cycle} still has an active/repair claim; scheduler hook skips concurrent re-dispatch`);
    return null;
  }
  const resumable = plan.shards.filter((shard) => {
    const claim = planClaims.find((candidate) => candidate.shardId === shard.id);
    return !claim || (claim.status === "failed" && claim.error === PROCESS_RESTART_ERROR);
  });
  if (resumable.length === 0) {
    log(`Shard plan ${plan.id} cycle ${plan.cycle} is terminal; scheduler hook skips re-execution`);
    return null;
  }
  if (planClaims.length > 0) {
    log(`Shard plan ${plan.id} cycle ${plan.cycle} resumes ${resumable.length} unclaimed or process-restart shard(s); completed and genuinely failed claims stay settled`);
  }

  const poolEntry = deps.pool ? null : getRunAgentPool(state.runId, deps.cwd, {});
  const pool = deps.pool ?? poolEntry!.pool;
  const broker = deps.broker ?? new CapabilityBroker(new PolicyEngine({ repoRoot: deps.cwd }));
  return await executeShardPlan(plan, {
    stateManager: deps.stateManager,
    pool,
    broker,
    cwd: deps.cwd,
    backend: deps.backend ?? "pi-subprocess",
    detectedBackend: deps.detectedBackend ?? poolEntry?.backend.kind ?? "none",
    signal: deps.signal,
    config,
    log: deps.log,
  });
}
