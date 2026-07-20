/**
 * Shard-level plan schemas (deployment plan Ch. 6 §6.1–6.3, Campaign 2).
 *
 * ShardPlanSchema EXTENDS the dormant PlanSpecSchema in src/domain/plan.ts:
 * a shard plan is the typed plan (id/version/tasks/createdAt, inherited by
 * spreading PlanSpecSchema.properties) plus the partition the sharder
 * computed from it. One `shard_posted` ledger event therefore carries both
 * the model-posted plan and the harness-computed shard decision, so replay
 * rebuilds the full picture from a single record.
 *
 * Shards are plan-level records (which files form which shard), NOT the
 * tool-call-level writer-batch validation of src/subagents.ts →
 * findShardViolations. The scheduler (C3) consumes the shard DAG; nothing
 * here dispatches work.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { PathScopeSchema, PlanSpecSchema, type PlanSpec } from "./plan.js";

/** A cut edge incident to a shard — a cross-shard contract (§6.3). */
export const ShardContractSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  weight: Type.Number(),
});

export const ShardSchema = Type.Object({
  id: Type.String({ description: "Stable shard id, e.g. shard-1." }),
  index: Type.Number({ description: "0-based partition block index." }),
  files: Type.Array(Type.String(), {
    description: "Normalized repository-relative file paths assigned to this shard.",
  }),
  taskIds: Type.Array(Type.String(), {
    description: "Plan task ids whose allowlists intersect this shard's files.",
  }),
  allowedPaths: Type.Array(PathScopeSchema, {
    description: "Union of the intersecting tasks' path scopes — the shard write scope.",
  }),
  crossShardContracts: Type.Array(ShardContractSchema, {
    description: "Cut edges incident to this shard; interfaces two shards must not change simultaneously.",
  }),
});

export const ShardDecisionEnum = StringEnum(["fan_out", "single_slice"] as const);

/**
 * Algorithm evidence. The spectral-as-prior-plus-refinement discipline of
 * §6.3 is recorded per shard plan so the acceptance gate (§8.5) asserts it
 * from the ledgered record, not from the implementation's say-so.
 */
export const ShardAlgorithmSchema = Type.Object({
  prior: Type.Literal("spectral-fiedler"),
  /** How the bisection assigned vertices before refinement: Fiedler sign split or balance-enforcing median split. */
  priorSplit: StringEnum(["sign", "median"] as const),
  refinement: Type.Literal("kernighan-lin"),
  /** Bisections executed (1 for the default two-way partition; >1 under recursive k-way bisection). */
  bisections: Type.Number(),
  /** KL passes that evaluated all cross-shard swaps (aggregated over bisections). */
  refinementPasses: Type.Number(),
  /** Cross-shard swap candidates evaluated (aggregated). */
  refinementEvaluatedSwaps: Type.Number(),
  /** Positive-gain swaps actually executed (0 = the spectral prior was confirmed locally optimal). */
  refinementSwapsExecuted: Type.Number(),
  refinementImproved: Type.Boolean(),
  /** Cut weight of the spectral prior before refinement. */
  initialCutWeight: Type.Number(),
});

export const ShardPlanSchema = Type.Object({
  // ── Inherited PlanSpecSchema fields (the dormant typed-plan contract). ──
  ...PlanSpecSchema.properties,
  // ── Shard-level extension. ──
  runId: Type.String({ description: "Owning run; record methods ignore mismatched runs (same guard as C1 subagent records)." }),
  cycle: Type.Number(),
  shards: Type.Array(ShardSchema),
  cutWeight: Type.Number({ description: "Total weight of edges severed by the final partition." }),
  totalEdgeWeight: Type.Number({ description: "Total weight of all edges in the dependency graph." }),
  couplingDensity: Type.Number({ description: "cutWeight / totalEdgeWeight (0 when the graph has no edges)." }),
  balanceTolerance: Type.Number({ description: "Imbalance fraction ε used for the balanced cut (§6.3 default 0.34)." }),
  decision: ShardDecisionEnum,
  decisionReason: Type.String(),
  algorithm: ShardAlgorithmSchema,
  postedAt: Type.String(),
});

export type Shard = Static<typeof ShardSchema>;
export type ShardContract = Static<typeof ShardContractSchema>;
export type ShardAlgorithm = Static<typeof ShardAlgorithmSchema>;
export type ShardDecision = Static<typeof ShardDecisionEnum>;
export type ShardPlan = Static<typeof ShardPlanSchema>;

/**
 * Typed plan posted through goal_post_shards, held until the sharder hook
 * runs at the plan→implement transition. Volatile by design: a restart
 * re-runs the plan phase, which re-posts. The DURABLE record is the
 * shard_posted event the hook emits (§6.1).
 */
export interface PendingShardPlan {
  plan: PlanSpec;
  cycle: number;
  postedAt: string;
  phaseAttemptId: string;
}

/** Claim lifecycle (§6.5): every award is ledgered shard_claimed → completed | failed. */
export type ShardClaimStatus = "claimed" | "completed" | "failed";

/**
 * THE dispatch task-id convention for scheduled shards (C4-OUS-008): the
 * scheduler builds dispatch ids through this helper and the merge-back hook
 * matches outcomes through the same one — never a duplicated string format —
 * so a rename here cannot silently disable merge-back.
 */
export function shardDispatchTaskId(cycle: number, shardId: string): string {
  return `sched-c${cycle}-${shardId}`;
}

/**
 * One shard-step award + outcome (Campaign 3). Lives beside ShardState for
 * cohesion — it is part of the replayed shard state — and follows the plain-
 * interface ledger-record precedent of SubagentTaskRecord in src/types.ts:
 * trusted at write time (same contract as SubagentTaskRecord); the runId
 * guard is the only check. A repair loop re-claim REPLACES the prior record
 * for the same (planId, cycle, shardId) — the full history stays in
 * events.jsonl; state keeps the latest episode.
 */
export interface ShardClaimRecord {
  shardId: string;
  /** Owning shard plan (PlanSpec id); claims match plans on (planId, cycle). */
  planId: string;
  runId: string;
  cycle: number;
  status: ShardClaimStatus;
  /** Concurrency slot the HEFT placement pre-assigned; null when no placement exists (posted-order / conservative fallback execution). */
  workerSlot: number | null;
  /** HEFT upward rank at award time; null when no telemetry-calibrated ranks exist. */
  rank: number | null;
  /** Subagent task id the claim was dispatched under (subagent_started/finished pair). */
  taskId: string | null;
  claimedAt: string;
  finishedAt: string | null;
  error: string | null;
  /**
   * Run-dir artifact holding the shard's captured patch bytes (C4-OUS-001),
   * repo-relative (.pi/iterative-goal/runs/...). Persisted at completion so a
   * crash before merge-back never strands the work — a warm restart rebuilds
   * merge inputs from ledgered claims + these artifacts. Null when the shard
   * produced no diff or no patch has been persisted yet.
   */
  patchArtifactPath: string | null;
}

/**
 * Merge lifecycle (§6.6 Figure D5): completed → merge_proposed → merge_verified
 * on gate pass; merge_proposed → failed on gate rejection (the shard_failed
 * replay transition marks the proposal rejected); failed → claimed on repair.
 */
export type ShardMergeStatus = "proposed" | "verified" | "rejected";

/**
 * One shard merge episode (Campaign 4). Plain-interface ledger record in the
 * ShardClaimRecord precedent: trusted at write time, runId-guarded, latest
 * episode per (planId, cycle, shardId) wins in state while events.jsonl keeps
 * every episode. The three-part merge gate's evidence rides the record so
 * replay and the acceptance gate read the same verdict the merge layer made.
 */
export interface ShardMergeRecord {
  shardId: string;
  /** Owning shard plan (PlanSpec id); merges match plans/claims on (planId, cycle). */
  planId: string;
  runId: string;
  cycle: number;
  status: ShardMergeStatus;
  /** sha256 of the exact patch text proposed for merge — provenance for the applied diff. */
  patchSha256: string;
  /**
   * Run-dir artifact holding the proposed patch bytes (C4-OUS-001),
   * repo-relative. Proposal-time pointer at the claim-persisted capture so a
   * warm restart can re-drive the merge from the ledger alone.
   */
  patchArtifactPath: string | null;
  /** Harness-owned integration branch the patch was applied onto. */
  integrationBranch: string;
  /**
   * Exact integration commit/tree state that passed the shard gate. For an
   * empty patch this is the already-verified predecessor commit; for a
   * non-empty patch it is the one commit created from patchSha256. Promotion
   * replays this chain and never trusts the mutable integration branch name.
   */
  integrationCommitSha: string | null;
  /** HEFT upward rank the merge order was taken from; null when unranked. */
  rank: number | null;
  /**
   * Gate evidence (§6.6): parts (1) per-shard allowlist verify and (2) the
   * repository test suite on the merged tree decide the merge; part (3) the
   * extended unfinished-work gate is recorded as a snapshot and enforced at
   * goal time by the evaluator (rejecting shard i because shard j has not
   * merged yet would deadlock the fan-out — completion is the evaluator's
   * gate, not the merge layer's). The snapshot is the POST-verdict view for
   * this shard: it excludes the shard being verified (C4-OUS-006), so the
   * ledger shows the gate actually clearing.
   */
  gate: {
    allowlistOk: boolean;
    extraFiles: string[];
    testsOk: boolean;
    testCommand: string | null;
    unfinishedWork: { pendingTaskItems: number; unverifiedShards: number } | null;
  } | null;
  /** Rejection reason (gate failure / patch conflict); null while proposed or verified. */
  error: string | null;
  proposedAt: string;
  verifiedAt: string | null;
}

/** Shard state carried on IterativeGoalState; rebuilt from shard_* events under replay. */
export interface ShardState {
  pendingPlan: PendingShardPlan | null;
  plans: ShardPlan[];
  /** Campaign 3 scheduler ledger: latest claim episode per (planId, cycle, shardId). */
  claims: ShardClaimRecord[];
  /** Campaign 4 merge ledger: latest merge episode per (planId, cycle, shardId). */
  merges: ShardMergeRecord[];
}
