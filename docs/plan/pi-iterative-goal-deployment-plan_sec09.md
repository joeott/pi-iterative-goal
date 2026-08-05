# 9. Risks, Caveats, and Decision Rules

This chapter consolidates the material risks from the counter-evidence review (Section 7.2) and the repository anatomy's verification flags, then states when swarm and shard machinery must not engage. The method is traceability: every risk cites its source cluster or repository flag, every mitigation is specified in Chapters 4–6, and the owner gate names the Chapter 8 campaign that must demonstrate it.

## 9.1 Risk register

| Risk | Likelihood | Impact | Mitigation | Owner gate |
|---|---|---|---|---|
| R1 — Stale HEFT cost estimates; adversarial instances degrade ~4.3× [^canon2008^][^saga2024^] | Medium | Medium | Telemetry-calibrated costs (`AgentResult.usage`); ranks recomputed on drift; ordering a default, never proof (§6.4) | Campaign 3 (scheduler) |
| R2 — Spectral-only cuts entrench weak partitions; balanced bisection is NP-hard [^buluc2016^] | Low | Medium | Spectral prior plus Kernighan–Lin refinement under balance tolerance, `src/kernel/sharder.ts` (§6.3) | Campaign 2 (sharder) |
| R3 — Contract-net awards locally optimal, globally incoherent; bids priced in tokens [^dias2006^] | Medium | Medium | Bounded shortlist bids; periodic global re-plan; awards ledgered `shard_claimed` (§6.5) | Campaign 3 |
| R4 — Multi-agent gains minimal or negative versus simple baselines; MAST's 14 failure modes [^mast2025^][^agentless2024^][^cognition-dont-build-multiagents-2025^] | High | High | Shardability gate pre-fan-out; benchmark against the single-agent fallback on the smoke corpus before default enablement (§5.3) | Campaign 1 (swarm wiring) |
| R5 — Token burn at 4–15× chat rates [^anthropic-multiagent-2025^] | High | Medium | Per-role budgets (`src/agents/roles.ts`); concurrency default 4, cap 8; ledgered usage telemetry (§5.2) | Campaign 1 |
| R6 — Judge position, verbosity, self-preference bias certifies weak output [^zheng2023^][^liusie2024^] | Medium | High | Judge independence (evaluator ≠ actor), rubric grading, deterministic checks first (§6.6, §7.3) | Campaign 4 (merge + evaluator) |
| R7 — Worktree isolation defers conflicts to merge time; contradictions survive clean merges [^conductor-2025^][^cognition-dont-build-multiagents-2025^] | Medium | High | Three-part merge gate — path-scope verification, tests, evaluator extended to `merge_verified`; HEFT-order merges via Integrator (§6.6) | Campaign 4 |
| R8 — Vendor-internal 90.2% headline over-read; advantage narrows as base models improve [^anthropic-multiagent-2025^][^single-or-multi-2025^] | Medium | Medium | Fan-out opt-in per task; re-benchmark on model upgrades; confidence labels on claims (§7.1) | Campaign 1 + standing rule |
| R9 — `ctx.ui.setHeader` re-render semantics unverified; `HarnessHeader.invalidate()` a no-op (`src/harness-ui.ts`) | Medium | Low | 1 Hz ticker pushes `setHeader` explicitly; fresh-factory fallback in `src/ui/phase-indicator.ts` (§4.2) | Campaign 0 (UI eventing) |
| R10 — Write-scope overlap check glob-prefix conservative, per-call only: missed cross-call conflicts (`src/agents/pool.ts → findWriteScopeConflict`) | Medium | Medium | Long-lived pool with cross-call `activeWriteScopes` registry; structured rejection naming the holder; lease-expiry release (§5.1) | Campaign 1 |

The register's center of gravity is instructive. The high-impact rows — R4, R6, R7 — are adoption and verification risks, not implementation risks: they fire when machinery performs as coded on work that should never be parallelized, or when certification is delegated to a conflicted judge. The algorithmic rows (R1–R3) are bounded by decomposition — calibration, prior-plus-refinement, satisficing-plus-replan — leaving wasted tokens, not corrupted state. Repository rows are milder but earliest: Campaign 0's header repair gates later observability, and R10's registry preconditions multi-writer batches. Likelihoods assume mitigations ship; a campaign that cannot produce gate evidence does not close, and later campaigns inherit earlier gates as regression checks.

Two process certainties escape likelihood logic. Branch hygiene: `fix/factory-state-manager` and `fix/harness-v2-optimizations` merged (PRs #1, #2) yet linger as stale branches; every campaign rebases on c6a3b75; stale branches should be deleted. Blocking turns: until Campaign 1, a `goal_subagent` call blocks one turn up to five minutes untraced; the ticker plus `subagent_started`/`subagent_finished` events make that wait visible (§5.2).

## 9.2 Decision rules: when not to shard

The shardability gate (§5.3, §6.1) operationalizes these rules. Do not shard or fan out when:

1. **The plan is small or densely coupled** — fewer than six allowlisted files, or the cheapest balanced cut severs a large fraction of import edges; the coupling-density check declines fan-out, keeping implement single-slice (§6.1).
2. **Tasks share mutable context** that cannot be split into disjoint writer `allowedPaths` — counter-indicated for multi-agent [^anthropic-multiagent-2025^] and irreconcilable at merge [^cognition-dont-build-multiagents-2025^]; demote to `mode:"chain"` or `mode:"single"`.
3. **Estimated coordination cost meets or exceeds the single-agent baseline** — the swarm must beat the smoke-corpus fallback before default enablement [^agentless2024^][^mast2025^].
4. **The only available judge is the actor's own model** — self-preference, position, and verbosity biases resist mitigation [^zheng2023^][^liusie2024^]; gate on deterministic checks alone.
5. **The merge surface exceeds review capacity** — more concurrent writer worktrees than Integrator and maintainer can verify per cycle; isolation defers, not eliminates, conflicts [^conductor-2025^]; serialize or lower the cap.
6. **Shard outputs are not independently verifiable** — nothing for `verifyImplementationAgainstPlan` (`src/workspace/change-set.ts`) to enforce; a shard whose done-state is opinion fails the gate.

The single most important caveat subsumes every row and rule: multi-agent machinery is a force multiplier for decomposable work and a cost-and-fragility multiplier for coupled work. What parallelizes six cleanly separated files will, on coupled work, burn 4–15× the tokens [^anthropic-multiagent-2025^], import the failure modes MAST catalogs [^mast2025^], and deliver a merge no conflicted judge can certify [^liusie2024^]. The shardability gate is therefore the plan's central control, not an accessory: every safeguard above assumes it runs first, runs conservatively, and may say no. Treating "do not shard" as failed ambition imports the failure modes this plan exists to avoid.
