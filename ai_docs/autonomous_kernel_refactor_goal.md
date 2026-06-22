# Autonomous Kernel Refactor Goal

Use this document as the authoritative goal packet for a Pi `/goal-start` run in `/Users/joe/Projects/pi-iterative-goal`.

## Objective

Refactor and harden `pi-iterative-goal` into a policy-governed, evidence-driven orchestration kernel. Preserve the existing strengths: run-scoped persistence, stale-write protection, phase-attempt identities, guarded shell/AWS/git adapters, model fallback behavior, and evaluator separation. Replace free-text workflow contracts and centralized orchestration with typed domain objects, a workflow kernel, central policy/capability enforcement, normalized evidence, real subagent execution, and release authorization.

The governing rule is:

> The kernel decides what state transitions are valid; capability providers decide how work is performed; policy decides whether effects are permitted; evidence and gates decide whether work is acceptable.

## Required Implementation Scope

1. Fix validation correctness.
   - Remove shell `eval`.
   - Represent validation commands as executable plus argv.
   - Capture per-check exit codes.
   - Mandatory `NOT_RUN` checks must fail their gate.
   - Gate failures must affect final script/result status.

2. Replace regex/fuzzy plan file allowlists.
   - Add typed `PathScope` objects.
   - Normalize repo-relative paths/globs.
   - Resolve symlinks and verify containment before writes.
   - Reject plan broadening unless represented as a reviewed plan amendment.

3. Add typed domain model.
   - Include `GoalSpec`, `Requirement`, `PlanTask`, `VerificationSpec`, `Evidence`, `ReviewFinding`, `ActionRequest`, `PolicyDecision`, and `ReleaseAuthorization`.
   - Runtime-validate all model/tool/plugin outputs with TypeBox or the repo's equivalent runtime schema validator.
   - Remove permissive `any` normalization at model boundaries where feasible.

4. Add central `CapabilityBroker` and `PolicyEngine`.
   - All effectful operations route through `ActionRequest -> PolicyDecision -> ActionResult`.
   - Cover fs, process, git, AWS/cloud, package install, network, subagent, and future MCP/browser/web/vision effects.
   - Existing `goal_shell`, `goal_aws_cli`, and `goal_git` must use the broker or a broker-compatible adapter.
   - Policy denials must include rule IDs and human-readable reasons.

5. Add commit/PR release authorization.
   - `goal_git create_pr` must require a short-lived `ReleaseAuthorization` bound to repository ID, base SHA, HEAD SHA, plan hash, requirements hash, gate verdict hash, and evidence root hash.
   - Re-read HEAD immediately before PR creation.
   - Any new commit, changed plan, changed requirements, changed base, or expired authorization invalidates the PR action.
   - PR body must be generated from structured evidence.

6. Replace `goal_subagent` hint behavior.
   - Implement `AgentPool` with `submit`, `map`, and `cancel`.
   - Add `PiSubprocessBackend` adapted from Pi's official subagent example.
   - Support isolated context, abort, usage accounting, bounded concurrency, structured outputs, and read-only reviewer/scout tasks.
   - Writer agents must not share a worktree or overlapping write scope.

7. Extract workflow kernel.
   - Make `src/index.ts` a composition root only, targeting 100-200 lines if practical.
   - Move transition rules, scheduling, recovery, and lifecycle handling into kernel modules.
   - Add explicit non-success/suspended states: `waiting_for_approval`, `blocked_external`, `requirement_conflict`, `budget_exhausted`, `provider_unavailable`, `policy_denied`, and `manual_intervention_required`.

8. Persistence.
   - Make the event log authoritative.
   - Prefer `node:sqlite` WAL if supported in the runtime; otherwise implement deterministic JSONL replay and document why SQLite is deferred.
   - Snapshots may exist only as performance caches.
   - Add replay, trace, and audit commands if feasible in this slice.

9. Model selection.
   - Limit repo defaults and local Pi harness model configuration to:
     - `deepseek/deepseek-v4-flash`
     - `xiaomi/mimo-v2.5`
     - `minimax/minimax-m3`
     - `tencent/hy3-preview`
     - `openrouter/owl-alpha`
     - `deepseek/deepseek-v4-pro`
     - `anthropic/claude-opus-4.7`
     - `anthropic/claude-opus-4.8`
     - `anthropic/claude-sonnet-4.6`
     - `z-ai/glm-5.2`
     - `openrouter/fusion`
     - `openrouter/pareto-code`
     - `openrouter/auto`
   - Verify IDs against the OpenRouter live catalog before finalizing config.
   - Remove stale or broken model IDs from harness config only. Do not disturb unrelated user configs.

## Quality Check Loop

After each meaningful implementation slice:

1. Run typecheck/build and relevant tests.
2. Run an independent adversarial review focused on bypasses, broken gates, stale writes, path-scope escapes, PR auth bypasses, event replay mismatch, and misleading success.
3. Run an Ousterhout architecture review focused on shallow modules, leaked provider details, pass-through abstractions, temporal decomposition, change amplification, and duplicated policy/parsing logic.
4. Convert reviewer findings into structured `ReviewFinding` records.
5. Remediate all blocker/high findings before continuing.
6. Do not allow the implementation agent to be the only reviewer of its own work.

## Commit And PR Strategy

- Work on a dedicated branch from current `main`.
- Preserve existing untracked user files unless explicitly part of this task.
- Use small audit-friendly commits:
  1. validation and fixture-independent tests
  2. typed domain/path scopes/model allowlist
  3. broker and policy adapters
  4. workflow kernel extraction
  5. agent pool/subprocess backend
  6. release authorization and PR body evidence
  7. event replay/audit commands
  8. docs/spec update
- Before each commit, record changed files, requirement IDs, tests run, and residual risk.
- Do not squash locally; preserve traceability.
- Open a PR only after `ReleaseAuthorization` passes for the exact HEAD.
- PR body must include requirement-to-evidence matrix, changed-file summary, tests with exit codes, security/adversarial review results, breaking-change notes, rollback instructions, and audit run ID.

## Testing Requirements

- Replace brittle smoke tests that depend on other checkouts with repo-local temp fixtures.
- Add unit tests for schemas, path scopes, policy decisions, validation exit handling, model allowlist, release auth invalidation, and replay.
- Add adapter-contract tests for shell/AWS/git/subagent providers.
- Add adversarial bypass tests:
  - fuzzy path containment
  - symlink escape
  - eval injection
  - gate failure masked as success
  - PR without auth
  - PR after new commit
  - policy bypass through bash/custom tool/subagent
- Run:
  - `npm run build`
  - `npm test` or the new canonical test command
  - `node scripts/smoke-goal-harness.mjs` or replacement smoke command
  - any new replay/release-gate smoke tests

## Production Runtime Confirmation

After local tests pass, test the built extension in the real local Pi runtime, not only unit tests.

Use a controlled production smoke goal in a disposable temp repo/worktree that exercises:

- goal start
- typed plan creation
- brokered shell execution
- validation gate failure and success
- adversarial review creation
- release authorization refusal before gates
- release authorization success after gates
- PR creation path in dry-run/mock mode unless an explicit real PR target is safe

Confirm no unintended writes outside the test repo and no unrelated Pi settings are changed. If real GitHub PR creation is tested, use a dedicated private test repo/branch and document URL, SHAs, and cleanup.

## Completion Criterion

Complete only when the refactor is implemented, build/tests pass, adversarial and architecture review blockers are resolved or explicitly waived with evidence, local Pi production-runtime smoke confirms functionality, release authorization prevents unaudited PR creation, and the final PR/audit packet traces requirements to tasks, evidence, commits, and breaking-change notes.
