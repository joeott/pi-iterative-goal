<!--
  File: goal.md
  Purpose: Living session contract used by /goal
  Seeded: 2026-07-20 13:17 CDT
  Session: pr8-production-certification
  Maintainers: joe + session agents
-->

# Goal — PR #8 Production Certification and Runtime Hardening

> `/goal` points here. This is the active long-running session contract. It
> defers to `northstar.md` for strategic motivation and non-negotiables,
> `state.md` for the current proof boundary and exact resume point, and
> `learnings.md` for durable truths. Do not duplicate or blur those roles.

## Session objective

Turn PR #8 (`feat/deployment-plan-c0-c4`) from a locally green implementation
with partial runtime evidence into a production-certifiable, resumable goal
orchestrator. Fix every production-blocking P0/P1 defect, exercise real Pi
runtime behavior through isolated headless/CLI and private-socket tmux TUI
runs, and publish exact-final-HEAD evidence without merging or deploying.

The selected production boundary is:

- real model calls are authorized within the budgets below;
- C1–C4 must be tested individually and in their valid combined configurations;
- GitHub/AWS/deploy effects are dry-run or read-only except ordinary commits and
  pushes that update PR #8;
- all feature defaults remain off after certification;
- PR #8 is updated, not automatically merged.

## Completion criteria

The session is complete only when all of the following are true:

1. Every P0/P1 item in the lane scoreboard is implemented or resolved by a
   tested design that fails closed.
2. A trusted runner—not a model-authored file—derives every required check
   result from the exact delivered HEAD and signs an attestation bound to it.
3. Real no-model CLI, tmux TUI, live-model individual-feature, all-on, malicious
   writer, repair, budget, cancellation, and crash-resume scenarios pass.
4. The all-on path produces real shard events, overlapping worker intervals,
   complete patches, verified integration commits, and an exact delivered SHA.
5. Deterministic pull-request CI is configured and green on the final PR head.
6. Compact receipts and this quartet of control documents are committed and
   visible on PR #8; raw bounded logs remain ignored local runtime evidence.
7. `state.md` records final local, TUI, live-provider, CI, PR, deploy, and
   corpus-proof labels separately. No absent gate is implied.

## Lane scoreboard

| Lane | Outcome | Initial status | Exit gate |
| --- | --- | --- | --- |
| L0 — truth and control plane | Install this document quartet and `/goal` wrappers; supersede stale evidence claims | validating | Local wrappers, exact-nine runtime materialization, and control docs pass; commit/PR visibility remains |
| L1 — worker containment | Isolated Pi workers, scoped tools/env, real budgets, exact cancellation, approval capabilities | validating | Deterministic escape, budget, cancellation, response-identity, credential, and phase-attempt approval gates pass locally |
| L2 — shard delivery and recovery | Complete patch capture, owned integration branch, bounded repair, crash replay, flag dependency semantics | validating | Deterministic complete-patch, immutable-base, chain-proof, promotion-CAS, lease, and restart gates pass locally |
| L3 — trusted verification | Kernel-owned structured checks, immutable signed attestations, delivered-HEAD release gate | validating | macOS Seatbelt executes deny-default checks; forged/stale/tampered/manual PASS and validation-HEAD drift fail closed locally |
| L4 — production matrix | Isolated headless and TUI runners plus live-model individual/combined scenarios | blocked-with-evidence | Six routes have live behavioral PASS; three exact OpenRouter routes are catalog-valid but blocked by HTTP 401; final CLI/tmux runs remain |
| L5 — CI and PR closeout | Deterministic CI, compact evidence, documentation reconciliation, final PR #8 update | pending | Required checks green and final receipt names remote PR head |

Status values are `pending`, `researching`, `implementing`, `validating`,
`blocked-with-evidence`, and `complete`. A lane becomes complete only when its
exit gate is attached to exact evidence.

## Invariants in force

- Preserve the pre-existing untracked `.pi/` runtime corpus and the three
  untracked `ai_docs` files named in `state.md`; never delete or absorb them.
- Never use, reconfigure, or kill the default tmux server. Every test owns a
  unique socket, config, session name, process group, and temporary root.
- Workers receive only the manifest-scoped repository tools needed for their
  role. No unrestricted built-in shell, Git, network, cloud, or secret access.
- A write lease remains held until process `close`; SIGTERM is followed by a
  bounded wait and exact process-group SIGKILL when necessary.
- Capture patches from an immutable base with untracked, binary, rename, delete,
  and worker-commit coverage. Zero diff never becomes completed or verified.
- The integration result must be promoted to the session branch before validate
  or release. Current HEAD must equal the recorded delivered SHA.
- Validation executes structured executable/argv checks with `shell:false` in a
  disposable validation worktree. Models cannot supply status at invocation.
- Model output that is malformed, degraded, over budget, or semantically
  contradictory is a failed attempt with preserved evidence.
- Static smoke, synthetic headless, real no-model CLI, TUI, live-provider, CI,
  GitHub delivery, deployment, and corpus certification are separate proof states.
- No production/cloud mutation, PR merge, history rewrite, broad process kill,
  or destructive cleanup is authorized by this contract.

## Orchestration rules

- Work one bounded lane slice at a time; keep at most one durable task marked
  `in_progress`. Parallelize only independent read/review/test work.
- Begin each slice by reading this quartet and current Git/PR/runtime truth.
- Research is read-only. The plan must name exact paths, checks, safety
  invariants, fallback, and authority before implementation.
- Use small audit-friendly commits. Each commit records requirement/lane IDs,
  changed files, checks and exit codes, evidence paths, and residual risks.
- Each material slice receives an independent adversarial/security review and
  an Ousterhout-style architecture review. Resolve blocker/high findings before
  advancing the lane.
- Update `learnings.md` with reproduced durable truths before each PR checkpoint.
  Update this scoreboard and append one evolution entry after every milestone.
- Replace `state.md` at every pause, compaction, operator handoff, and before and
  after long live-model runs. It is a snapshot, not an append-only journal.
- For swarm runs, use the repository monitor convention: deterministic trace
  every 6 minutes, supervisor reconciliation every 24 minutes, retained journal,
  and an `ACTIVE` marker that is removed at clean stop.
- Re-run the complete deterministic gate and production receipt on the final
  commit after all code and documentation changes. Evidence from an ancestor
  does not certify a descendant.

## Runtime budgets

- Targeted worker/reviewer scenario: at most 24 model responses, 200k tokens,
  USD 2, and 10 minutes.
- All-on scenario: at most 60 model responses, 500k tokens, USD 5, and 20 minutes.
- Complete production suite: at most 240 model responses and USD 20.
- Each shard has at most three attempts. Budget exhaustion is terminal evidence,
  not permission to silently continue.

## Stop rules

Stop the affected lane, preserve evidence, and update `state.md` when:

- a secret is exposed or a child can read an undeclared credential;
- any write escapes an owned worktree/temp root or a default tmux session changes;
- HEAD/base/plan/check digests drift during delivery or release;
- a required check, signature, cleanup check, or proof manifest fails;
- a model/provider exceeds its declared budget or returns degraded evidence;
- destructive or production authority is needed beyond this contract;
- the same blocker survives three bounded attempts.

Continue an independent safe lane when possible. Never turn a blocked lane into
a broad workaround or a weaker completion claim.

## Evolution log (append-only)

| Timestamp | Milestone | Contract change | Proof boundary |
| --- | --- | --- | --- |
| 2026-07-20 13:17 CDT | L0 seeded | Created the long-running objective, lanes, invariants, budgets, stop rules, and control-doc cadence | Local working-tree documents only; not committed, pushed, CI-green, or production-certified |
| 2026-07-20 13:22 CDT | L0 locally validated | Verified history preservation, narrow `.pi` admission, clean patch whitespace, and Pi RPC discovery of `/goal` | Still local and uncommitted; PR #8 does not yet contain the control plane |
| 2026-07-20 14:50 CDT | L1–L3 deterministic hardening | Enforced custom worker tools and selected credentials, exact process budgets, complete Git delivery proof, phase-attempt approvals, signed trusted checks, telemetry, and bounded retention | Full local deterministic chain passes; changes remain uncommitted and do not yet certify PR HEAD |
| 2026-07-20 14:50 CDT | Exact-nine provider probe | Bound runtime policy to roster hash `683bac3a...9601`; six routes passed live behavior and all three OpenRouter names passed catalog validation | OpenRouter inference remains blocked by HTTP 401; no substitution or fallback was accepted |
