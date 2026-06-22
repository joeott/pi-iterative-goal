# Autonomous Kernel Refactor Audit

Branch: `refactor/autonomous-kernel-p0-p1`

Authoritative goal: `ai_docs/autonomous_kernel_refactor_goal.md`

## Requirement Map

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R1 | Validation uses executable plus argv, no `eval`, per-check exit codes, mandatory missing checks fail, gate failure affects status | Partial | `src/domain/verification.ts`, smoke test 5; full gate matrix still pending |
| R2 | Typed path scopes replace regex/fuzzy allowlists; repo-relative normalization; symlink containment before writes; plan broadening via amendments | Partial | `src/domain/path-scope.ts`, smoke test 4; amendments not implemented |
| R3 | Typed domain objects and runtime validation at model/tool/plugin boundaries | Partial | `src/domain/*`, `src/evaluator.ts`; plugin/provider contract tests pending |
| R4 | Central CapabilityBroker and PolicyEngine for fs/process/git/AWS/cloud/package/network/subagent/future effects | Partial | `src/policy/engine.ts`, `src/capabilities/broker.ts`, `src/shell.ts`; AWS/git direct adapters not fully broker-routed |
| R5 | SHA-bound ReleaseAuthorization required for PR creation and structured PR evidence | Partial | `src/release/controller.ts`, `src/git.ts`, smoke test 18; PR body generator incomplete |
| R6 | Real AgentPool/Pi subprocess backend with cancel/map/usage and writer isolation controls | Partial | `src/agents/pool.ts`, `src/subagents.ts`; writer roles fail closed until worktree ownership lands |
| R7 | Workflow kernel extraction and `index.ts` composition root target | Partial | `src/kernel/workflow-engine.ts`, `src/workspace/change-set.ts`, `src/review/gates/release-gate.ts`, `src/ui/commands.ts`; `src/index.ts` is reduced but still orchestration-heavy |
| R8 | Event log authoritative with SQLite WAL or deterministic replay; audit/trace/replay commands | Partial | `src/state.ts` deterministic replay for new runs, `/goal-audit`, `/goal-replay`, `/goal-trace`, smoke tests 16-17 |
| R9 | Model defaults/local config limited to approved OpenRouter set and verified live | Partial | `src/domain/models.ts`, local `~/.pi/agent/*`; live verification performed manually |
| R10 | Quality loop after slices: build/tests, adversarial review, Ousterhout review, structured ReviewFinding records, remediate blocker/high | Partial | `ai_docs/reviews/*`, review disposition table below; second review pass pending |
| R11 | Small audit-friendly commits on dedicated branch | In progress | branch created; commits pending |
| R12 | Testing requirements: repo-local fixtures, unit/adapter/adversarial/replay/release-gate tests | Partial | smoke expanded; adapter/replay/runtime tests incomplete |
| R13 | Real local Pi runtime smoke in disposable repo with no unintended writes | Not done | pending |
| R14 | Final PR/audit packet with requirement-to-evidence matrix, tests, review results, rollback, audit run ID | Not done | this audit file is seed |

## Review Findings

| ID | Severity | Source | Status | Disposition |
| --- | --- | --- | --- | --- |
| FINDING-001 | high | adversarial | resolved | `validateReleaseAuthorization()` rereads repository, base SHA and HEAD; smoke test 18 proves a new HEAD invalidates the authorization. |
| FINDING-002 | high | adversarial | resolved | `goal_shell` now invokes `CapabilityBroker`/`PolicyEngine`, and process safety classification is centralized in `PolicyEngine`. |
| FINDING-003 | high | adversarial | resolved-by-deny | `goal_subagent` blocks writer roles until isolated worktree ownership and scoped write leases are implemented; read-only subprocesses receive only read/grep/find/ls. |
| FINDING-004 | high | adversarial | resolved | `src/domain/path-scope.ts` normalizes repository-relative paths, rejects traversal and fuzzy containment, and smoke test 4 covers the bypass class. |
| FINDING-005 | high | adversarial | resolved | `/goal-authorize-release` now requires a local release gate covering clean status, scope verification and completed validation evidence before issuing authorization. |
| FINDING-006 | high | adversarial | invalid-review-scope | The reviewed diff omitted new untracked `src/release/controller.ts`; the release controller is now included in the audit scope and smoke test 18 covers stale HEAD rejection. |
| FINDING-007 | medium | adversarial | resolved | Event replay now fails closed for unknown/corrupt new-run events rather than silently ignoring them. |
| FINDING-008 | medium | adversarial | resolved | New runs with authoritative event logs do not fall back to stale `state.json` after replay corruption; smoke test 17 covers this. |
| DES-EVAL-01 | high | Ousterhout | resolved | `parseVerdict` again accepts embedded JSON, then validates with the schema boundary. |
| DES-EVAL-02 | medium | Ousterhout | resolved | Legacy `next_cycle_directive` is normalized to `next_focus`/`next_focus_reason` before schema validation. |
| DES-SHL-01 | high | Ousterhout | partially-resolved | The broker is still thin but now owns central process safety decisions; deeper capability leases and provider manifests remain P1/P2 work. |
| DES-SHL-02 | high | Ousterhout | waived-intentional | Blocking pipelines/subshells is required by the no-`eval`, executable-plus-argv policy. The failure mode is explicit and fail-closed. |
| DES-SUB-01 | high | Ousterhout | waived-intentional | The target design starts with `PiSubprocessBackend`; non-CLI tool backends can be added behind `AgentPool` later. |
| DES-TYPES-01 | high | Ousterhout | resolved | `goal_git create_pr` validates plan, requirements, gate and evidence hashes against the active state before opening a PR. |
| DES-STATE-01 | medium | Ousterhout | intentional | New-run event logs are authoritative by design; legacy snapshots remain a compatibility fallback. |
| DES-EVT-01 | medium | Ousterhout | resolved | Replay now uses an event-handler map instead of a linearly growing switch while preserving fail-closed behavior for unknown new-run events. |
| DES-CMD-01 | medium | Ousterhout | resolved | Governance commands moved into `src/ui/commands.ts`; `index.ts` delegates release/audit/replay/trace registration to a UI adapter. |
| FINDING-009 | medium | adversarial slice 2 | resolved | Path-scope extraction now handles explicit extensionless repo paths such as `Dockerfile` and `scripts/deploy`; smoke test 4 covers this. |

## Slice Evidence

- `2026-06-22`: `npm run validate` passed locally with 18 smoke checks.
- `2026-06-22`: Extracted `src/kernel/workflow-engine.ts`, `src/workspace/change-set.ts` and `src/review/gates/release-gate.ts`; `src/index.ts` is 1295 lines after extraction.
- `2026-06-22`: Refactored authoritative event replay into an event-handler map; `npm run validate` passed.
- `2026-06-22`: Extracted governance commands into `src/ui/commands.ts`; `src/index.ts` is 1189 lines after extraction and `npm run validate` passed.
- Review artifacts: `ai_docs/reviews/adversarial-slice-001-findings.json`, `ai_docs/reviews/ousterhout-slice-001-findings.json`, `ai_docs/reviews/adversarial-slice-002-findings.json`.
