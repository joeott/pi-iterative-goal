# North Star — Trustworthy Production Goal Orchestration

> Long-term direction and non-negotiables for `pi-iterative-goal`. This file
> changes only when the strategic objective, success standard, or proof doctrine
> changes. Active lane status belongs in `goal.md`; exact handoff state belongs
> in `state.md`; durable discoveries belong in `learnings.md`.

## Vision

Make `pi-iterative-goal` a production-trustworthy autonomous supervisor: it can
research, plan, implement, validate, recover, and deliver work over long sessions
without confusing model confidence with proof or local activity with production
completion.

The harness should let an operator start one durable goal, leave it running,
inspect its exact state in tmux or headlessly, interrupt and resume it safely,
and receive a final result whose code, checks, evidence, resource use, and Git
lineage can be independently reproduced from the delivered commit.

## Strategic outcome

A successful system has five properties:

1. **Kernel authority.** The kernel owns transitions, leases, budgets, validation
   verdicts, release authorization, and terminal state. Models propose work and
   evidence; they never grant themselves PASS or release authority.
2. **Effect isolation.** Every writer runs in an owned workspace with a bounded
   tool surface, sanitized environment, symlink-safe path scope, exact process
   ownership, and operating-system filesystem enforcement where available.
3. **Exact delivery.** Create, modify, delete, rename, binary, and committed
   worker changes are captured from an immutable base and delivered to the
   session branch only after merge and trusted checks. A ledger-only merge is
   not delivery.
4. **Truthful production proof.** Static, synthetic, headless, TUI, live-model,
   CI, GitHub, deployed, and real-corpus proof remain distinct labels. Every
   receipt binds the exact code and runtime that produced it.
5. **Durable prosecution.** Event replay, checkpoints, task state, monitor
   journals, and tracked control documents make a long run resumable after
   crashes, compaction, provider failures, or operator handoff.

## Non-negotiables

### Evidence and completion

- Completion is evaluator- and gate-owned, never implementation-model-owned.
- A required check is PASS only when the trusted runner executed its structured
  executable and argv and derived a zero exit status from the delivered HEAD.
- Repair proof must show the same check ID fail and later pass; unrelated denial
  and success events cannot substitute for that transition.
- Malformed, degraded, stale, unsigned, over-budget, restarted, or incomplete
  evidence fails closed.
- Historical artifacts remain immutable. Corrections supersede claims explicitly
  rather than rewriting old evidence into a stronger result.

### Safety and ownership

- No child receives ambient Git, shell, network, cloud, or unrelated credential
  authority. Capabilities are explicit, task-bound, expiring, and least-privilege.
- Destructive work requires an exact, current, single-use operator approval bound
  to run, cycle, cwd, executable, argv, and resource.
- Cancellation retains the write lease until the owned process group exits.
- Cleanup targets only validated run-owned PIDs, sockets, worktrees, branches,
  indexes, and temporary roots. User tmux sessions and untracked artifacts are
  never collateral cleanup.
- AWS and deployment mutations remain outside routine certification. GitHub writes
  require the explicitly selected delivery path and exact release authorization.

### Compatibility and rollout

- All C1–C4 production features remain off by default until a separate real-corpus
  quality, latency, reliability, and cost decision authorizes a default change.
- Invalid flag dependency combinations fail before state or filesystem mutation.
- All-off behavior remains regression-compatible; feature-on certification is
  additive and explicitly named.
- The source worktree, user configuration, and pre-existing untracked content are
  unchanged by disposable production tests.

## Decision hierarchy

When tradeoffs conflict, optimize in this order:

1. Evidence truth and secret safety.
2. Effect containment and exact ownership.
3. Deterministic recovery and delivery correctness.
4. Operator observability and reproducibility.
5. Backward compatibility.
6. Latency, model quality, concurrency, and cost.

## North-star completion measure

The project reaches this north star when an operator can run the individual and
combined feature matrix through both a private tmux TUI and headless CLI with real
models; survive forced worker and merge crashes; reject malicious effects before
they occur; deliver the verified integration result to an exact final commit;
reproduce every trusted check and signed receipt from that commit; and observe
green deterministic CI—without touching unrelated tmux sessions, settings,
repositories, credentials, cloud resources, or user-owned files.
