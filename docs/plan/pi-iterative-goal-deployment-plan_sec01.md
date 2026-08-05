# 1. Executive Summary

This document is a deployment plan for `joeott/pi-iterative-goal`, a TypeScript extension that drives the Pi Coding Agent through an autonomous four-phase supervisor loop — research, plan, implement, validate — gated by an external evaluator. Every repository claim is pinned to `main` @ `c6a3b75`; every design claim traces to a verified seam, a dormant asset, or a named gap.

### The ask and the finding

The engineering owner asked for three capabilities the harness lacks today: clean, live rendering of the current phase in the Pi terminal user interface (TUI); swarming — supervisor fan-out to specialist subagents; and effective sharding of implementation work once research and planning complete. The current-state assessment (Chapter 2) returns the plan's decisive finding: most of the required machinery already ships in dormant form. The typed plan model `PlanSpecSchema`, the bounded-concurrency primitive `AgentPool.map`, the dependency-graph field `AgentTask.dependsOn`, the user-facing `mode` fan-out switch, the git-worktree isolation primitive, and the hash-chained event ledger are all verified present at the pinned commit and consumed by nothing. The deployment is therefore wiring and promotion, not greenfield construction — which concentrates risk at integration seams already covered by the repository's own smoke and headless test runners.

### What gets built

UI visibility lands as a single renderer, `src/ui/phase-indicator.ts`, fed by a monotonic version counter inside the event-sourced StateManager and a 1 Hz ticker — the first interval timer in `src/`. Phase, elapsed time, evaluator state, and task progress repaint within one second, and six verified rendering defects collapse into one ownership fix (Chapter 4).

Swarming lands by wiring the dead `mode` parameter of `goal_subagent` to `AgentPool.map` and promoting the pool to a long-lived per-run instance with a cross-call write-scope registry, per-role tool and budget profiles, and ledger plus TUI visibility for every subagent run. The single-agent fallback contract is preserved throughout, so a swarm with no working backend degrades to today's behavior (Chapter 5).

Post-plan sharding lands as three modules: `src/kernel/sharder.ts` (spectral-seeded partitioning with local refinement), `src/kernel/scheduler.ts` (HEFT scheduling with contract-net assignment), and `src/workspace/worktrees.ts` (worktree isolation with patch merge-back and a three-part merge gate) (Chapter 6). Five diagrams anchor the design: D1, the instrumented loop, and D2, the deployment topology, live in Chapter 3; D3, the UI change-feed data flow, in Chapter 4; D4, the sharding pipeline, and D5, the shard lifecycle, in Chapter 6.

### Why this is credible

Each orchestration pattern passed a symmetric evidence review that sought the strongest support and the strongest counter-evidence (Chapter 7). HEFT (Heterogeneous Earliest Finish Time) scheduling, spectral partitioning as a component, and LLM-as-judge gating under bias controls rate STRONG. Multi-agent orchestration rates MODERATE and explicitly task-dependent: the headline support is a 90.2% gain on a vendor-internal research evaluation [^anthropic-multiagent-2025^], balanced against 4–15× token costs and a peer-reviewed taxonomy of fourteen multi-agent failure modes [^mast2025^]. Wherever the evidence is conditional, the condition ships as enforced code — telemetry-calibrated costs, prior-plus-refinement, bounded bidding — not as documentation.

### How it ships

Five campaigns, each independently shippable, each gated by extensions to the existing `npm run smoke` and `npm run evidence:headless` runners (Chapter 8). C0 lands UI eventing first: additive, zero loop-motor risk, and the observability substrate for everything after. C1 wires the swarm behind a feature flag and must beat the single-agent baseline before default enablement. C2 adds the sharder, C3 the scheduler, and C4 merge-back with signed evidence. Rollback is a revert for C0 and a flag-flip thereafter.

### The central control

The plan's closing discipline is the shardability gate (Chapter 9). Multi-agent machinery is a force multiplier for decomposable work and a cost-and-fragility multiplier for coupled work: the fan-out that parallelizes six cleanly separated files will, on coupled code, burn an order of magnitude more tokens and produce a merge no conflicted judge can certify. Two mechanisms keep the deployment on the right side of that line. The sequencing invariant permits sharding only after the research and plan artifacts commit, so decomposition never runs ahead of understanding. The gate itself inspects coupling density before any fan-out and may say no, demoting the implement phase to its single-slice path at zero cost. "Do not shard" is a successful outcome of this plan, not a failed ambition.
