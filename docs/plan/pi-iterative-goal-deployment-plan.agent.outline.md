# Outline: pi-iterative-goal Harness Efficacy Deployment Plan

**File base name:** `pi-iterative-goal-deployment-plan`
**Audience:** the repo owner (solo maintainer), engineering-grade reader
**Style:** technical report style (precise, methodology-transparent, reproducible)
**Citations:** external sources cited as `[^slug^]` (slug from evidence doc, e.g. `[^topcuoglu2002^]`, `[^anthropic-multiagent-2025^]`); repo facts cited inline as `src/file.ts → symbol`. No reference lists inside chapter files.
**Palette (for any raster charts):** DUSK `['#7B6D8D', '#9B8EA8', '#6C5B7B', '#B8A9C9', '#584A6E', '#A394B4', '#8E7BA5']`, dark-gray text (#333333).
**Diagrams:** mermaid code blocks, IDs D1–D6 as assigned below. Keep node labels short. Use `flowchart`/`stateDiagram-v2`/`sequenceDiagram` only.

## Canonical design vocabulary (all chapters MUST use these names)
- `src/ui/phase-indicator.ts` — new single source of truth for phase rendering (status bar, widget, header)
- `src/kernel/sharder.ts` — builds dependency graph from plan output, partitions into shards
- `src/kernel/scheduler.ts` — HEFT-ordered DAG scheduler + contract-net style assignment over the agent pool
- `src/workspace/worktrees.ts` — promoted worktree lifecycle (from `src/agents/pool.ts → prepareIsolatedWorktree`) + patch apply/merge-back + prune recovery
- `src/domain/shard.ts` — `ShardSchema`/`ShardPlanSchema` (extends the dormant `PlanSpecSchema` in `src/domain/plan.ts`)
- New ledger event types: `shard_posted`, `shard_claimed`, `shard_completed`, `shard_failed`, `subagent_started`, `subagent_finished`, `merge_proposed`, `merge_verified`
- StateManager change feed: version counter + subscriber callback consumed by a 1 Hz UI ticker (no `setInterval` exists today)
- Shardability gate: decomposition check before any fan-out (multi-agent is counter-indicated for tightly coupled work)
- Judge independence rule: evaluator model ≠ actor model; rubric-based; deterministic checks first

## Chapters

### sec01 — Executive Summary (~700 words) — ROUND 3
Decision framing, three capability gaps (UI visibility, swarming, sharding), the five-campaign rollout, headline evidence caveats.

### sec02 — Current-State Assessment (~1400 words) — ROUND 1 — inputs: dim01
- 2.1 The four-phase loop and its verified strengths (event-sourced hash-chained ledger, policy engine, capability preflight, worktree isolation primitive, headless evidence runners)
- 2.2 Gap analysis: UI visibility (G1–G6), swarm substrate (S1–S6), sharding seams
- 2.3 The dormant assets: `PlanSpecSchema`, `AgentPool.map`, `AgentTask.dependsOn`, `mode` param, `CapabilityLease`
- Required: gap table (Gap ID | Location | Symptom | Deployment impact)

### sec03 — Target Deployment Architecture (~1200 words) — ROUND 2 — inputs: sec04–06
- 3.1 Topology: run controller → coordinator (loop motor) → sharder → scheduler → worker pool → merge/evaluator (D2)
- 3.2 The instrumented loop: where each new module attaches (D1)
- 3.3 Blackboard: event ledger as the coordination substrate; pub/sub via change feed
- Diagrams: D1 (loop with sharder hook), D2 (deployment topology)

### sec04 — UI Visibility: Clean Live Phase Rendering (~1400 words) — ROUND 1 — inputs: dim01
- 4.1 Problem: stale header (G1), transition-only repaint (G2), invisible evaluator (G3), hidden task plan (G4), fake progress (G5), dual ownership (G6)
- 4.2 Design: `phase-indicator.ts` single renderer; StateManager version counter + 1 Hz ticker; event-driven invalidation; live `DashboardComponent`
- 4.3 Render spec: status bar line, widget block, header, modal dashboard — exact content per surface incl. elapsed time, evaluator heartbeat, in-progress task, shard counts
- 4.4 Data flow (D3); acceptance checks
- Diagram: D3 (state → change feed → indicator → surfaces)

### sec05 — Swarming Capabilities (~1500 words) — ROUND 1 — inputs: dim01, dim02, user file 2 (12 patterns)
- 5.1 From dead schema to real fan-out: wire `mode:"parallel"|"chain"` to `AgentPool.map`; long-lived pool; backend detection honored
- 5.2 Roles, budgets, output schemas per role; shardable ledger events; swarm status in TUI
- 5.3 Topology guidance per evidence: supervisor→specialists for breadth-first work; shardability gate for coding work; cost expectations (~4–15× tokens)
- 5.4 Failure handling: cancellation, reassignment, single-agent fallback preserved

### sec06 — Post-Plan Sharding Pipeline (~1800 words) — ROUND 1 — inputs: dim01, dim02, user files 1+2
- 6.1 Attach seam: plan→implement transition in `kernel/lifecycle.ts → advanceToNextPhase()`; typed plan via `PlanSpecSchema`
- 6.2 Dependency graph construction (imports/calls as edges, files as vertices)
- 6.3 Partitioning: spectral bisection (Fiedler vector) as prior + local refinement; balance tolerance; why not spectral-only (NP-hard, multilevel dominance) — math from user file 1
- 6.4 Scheduling: HEFT upward rank + EFT with telemetry-calibrated costs (D4)
- 6.5 Assignment: contract-net style capability/cost bidding as satisficing layer + periodic global re-plan
- 6.6 Execution isolation: `workspace/worktrees.ts`, merge-back, shard lifecycle (D5); evaluator gate preserved
- Diagrams: D4 (pipeline), D5 (shard state machine)
- Required: one worked mini-example (6-file graph, Laplacian, Fiedler sign split) in a table

### sec07 — Pattern Proof & External Validation (~1500 words) — ROUND 1 — inputs: dim02
- 7.1 Evidence summary per pattern: HEFT (STRONG), spectral (STRONG as component), contract net (MODERATE), blackboard (MODERATE), LLM orchestration (MODERATE, task-dependent), LLM-as-judge (STRONG w/ controls), worktrees (MODERATE)
- 7.2 Counter-evidence and failure modes (MAST, Agentless, Cognition, judge biases)
- 7.3 Deployment implications table (Pattern | Confidence | Mandated safeguard)
- Every claim cited `[^slug^]`

### sec08 — Phased Rollout Campaign & Acceptance Gates (~1300 words) — ROUND 2 — inputs: sec02–07
- Campaign 0: UI eventing + phase-indicator (touches dashboard.ts/harness-ui.ts/lifecycle.ts/state.ts)
- Campaign 1: swarm wiring (subagents.ts/pool.ts/ledger events)
- Campaign 2: sharder (domain/shard.ts, kernel/sharder.ts, typed plan emission)
- Campaign 3: scheduler + assignment (kernel/scheduler.ts, telemetry cost model)
- Campaign 4: merge-back + evidence (workspace/worktrees.ts, evaluator integration, headless runner extensions)
- Each campaign: scope, files, acceptance gate tied to `npm run smoke` / `evidence:headless`, rollback note; rebase note on c6a3b75

### sec09 — Risks, Caveats, and Decision Rules (~800 words) — ROUND 2 — inputs: sec07
Cost multipliers, error propagation, merge-time conflict surface, judge bias controls, stale-branch hygiene, when NOT to shard.

### _ref — References (assembled at Stage 4 from dim02 evidence tables)
