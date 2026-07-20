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

/** Shard state carried on IterativeGoalState; rebuilt from shard_posted events under replay. */
export interface ShardState {
  pendingPlan: PendingShardPlan | null;
  plans: ShardPlan[];
}
