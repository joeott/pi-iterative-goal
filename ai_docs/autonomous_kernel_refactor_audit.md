# Autonomous Kernel Refactor Audit

Branch: `refactor/autonomous-kernel-p0-p1`

Authoritative goal: `ai_docs/autonomous_kernel_refactor_goal.md`

## Requirement Map

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R1 | Validation uses executable plus argv, no `eval`, per-check exit codes, mandatory missing checks fail, gate failure affects status | Complete | `src/domain/verification.ts`, smoke test 5 executes generated scripts in temporary git repos and verifies success, gate failure, and missing-command failures |
| R2 | Typed path scopes replace regex/fuzzy allowlists; repo-relative normalization; symlink containment before writes; plan broadening via amendments | Complete | `src/domain/path-scope.ts`, `src/domain/plan.ts`, `src/workspace/change-set.ts`, smoke tests 4 and 15 |
| R3 | Typed domain objects and runtime validation at model/tool/provider boundaries | Complete | `src/domain/*`, `src/evaluator.ts`, `src/capabilities/manifest.ts`, `src/capabilities/registry.ts`, `src/capabilities/broker.ts`; smoke tests cover evaluator, agent output, broker output, and provider manifest contracts |
| R4 | Central CapabilityBroker and PolicyEngine for fs/process/git/AWS/cloud/package/network/subagent/future effects | Partial | `src/policy/engine.ts`, `src/capabilities/broker.ts`, `src/capabilities/manifest.ts`, `src/capabilities/filesystem/provider.ts`, `src/capabilities/process/provider.ts`, `src/shell.ts`, `src/aws-cli.ts`, `src/git.ts`, `src/subagents.ts`; browser/MCP provider effects still need full broker enforcement |
| R5 | SHA-bound ReleaseAuthorization required for PR creation and structured PR evidence | Complete | `src/release/controller.ts`, `src/release/pr-body.ts`, `src/git.ts`, smoke tests 18-19; runtime dry-run PR smoke validated auth and generated structured PR body |
| R6 | Real AgentPool/Pi subprocess backend with cancel/map/usage and writer isolation controls | Complete | `src/agents/pool.ts`, `src/subagents.ts`, smoke test 16; writer roles use isolated worktrees, patch capture, write-scope overlap checks and structured output validation |
| R7 | Workflow kernel extraction and `index.ts` composition root target | Complete | `src/kernel/workflow-engine.ts`, `src/kernel/lifecycle.ts`, `src/kernel/output-synthesis.ts`, `src/workspace/change-set.ts`, `src/review/gates/release-gate.ts`, `src/ui/commands.ts`, `src/ui/goal-commands.ts`, `src/ui/tools.ts`, `src/ui/tool-interception.ts`; `src/index.ts` is 139 lines |
| R8 | Event log authoritative with SQLite WAL or deterministic replay; audit/trace/replay commands | Complete | `src/state.ts` deterministic replay for new runs with chained event hashes, `/goal-audit`, `/goal-replay`, `/goal-trace`, smoke tests 17-18 |
| R9 | Model defaults/local config limited to approved OpenRouter set and verified live | Complete | `src/domain/models.ts`, local `~/.pi/agent/settings.json`, local `~/.pi/agent/models.json`; `pi --list-models` verified all 13 slugs; OpenRouter Fusion page verified live |
| R10 | Quality loop after slices: build/tests, adversarial review, Ousterhout review, structured ReviewFinding records, remediate blocker/high | Partial | `ai_docs/reviews/*`, review disposition table below; broader final review still pending |
| R11 | Small audit-friendly commits on dedicated branch | Complete | Branch `refactor/autonomous-kernel-p0-p1` contains scoped commits per validation, policy, agent, release, persistence, provider and UI extraction slice |
| R12 | Testing requirements: repo-local fixtures, unit/adapter/adversarial/replay/release-gate tests | Partial | smoke expanded; adapter/replay/runtime tests incomplete |
| R13 | Real local Pi runtime smoke in disposable repo with no unintended writes | Partial | Fresh `goal_shell` runtime smoke passed in `/tmp/pi-iterative-goal-tool-smoke-F7ppUF`; earlier `/goal-start` and PR dry-run smokes passed in `/tmp/pi-iterative-goal-start-smoke-CJatWs` and `/tmp/pi-iterative-goal-pr-dryrun-bhTPRK`; tracked files remained clean |
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
| REL-FLOW-001 | high | runtime/release slice | resolved | `goal_git create_pr` now reruns the local release gate and validates the same evaluator plus localReleaseGate hash used when authorization is issued. |
| REL-FLOW-002 | medium | runtime/release slice | resolved | `goal_git` refreshes finalization policy from current project settings on each invocation, avoiding stale replayed policy. |
| GIT-POLICY-001 | info | git policy slice | resolved | Git branch/stage/commit/push/PR effects now consult `PolicyEngine`; smoke test 15 covers commit and PR allow/deny decisions. |
| PLAN-AMEND-001 | info | plan amendment slice | resolved | Accepted typed `PlanAmendment` scopes are honored during change-set verification; proposed/unreviewed amendment scopes are ignored. |
| AGENT-ISO-001 | info | agent isolation slice | resolved | Writer subagents use disposable detached git worktrees, return patches, clean workspaces, reject overlapping active write scopes and validate structured outputs. |
| CAP-POL-001 | info | capability/persistence slice | resolved | Capability manifests, broker output schemas, AWS broker evidence, filesystem provider policy checks and process provider execution are covered by smoke tests 11 and 15. |
| CAP-POL-002 | medium | capability/persistence slice | partially-resolved | Subagent subprocess launches now pass through `CapabilityBroker`; browser/MCP provider effects are still tracked as remaining R4 work. |
| CAP-POL-003 | medium | CLI capability slice | resolved | Generic CLI execution is represented by `ProcessProvider`, package installation is denied at the central policy boundary, and AWS profile defaults no longer include project-specific profile names. |
| EVT-AUD-001 | info | capability/persistence slice | resolved | Chained event-log replay rejects tampering and corrupt replay. |
| DES-CAP-001 | info | Ousterhout capability slice | resolved | Provider-specific schema and health details are hidden behind manifest/registry contracts. |
| DES-IDX-001 | medium | Ousterhout capability slice | resolved | `index.ts` is now a 139-line composition root; lifecycle, commands, tools, synthesis and interception are extracted behind narrow modules. |
| DES-FS-001 | info | Ousterhout capability slice | resolved | Filesystem provider owns read/write/delete execution while broker and policy remain centralized. |

## Slice Evidence

- `2026-06-22`: `npm run validate` passed locally with 18 smoke checks.
- `2026-06-22`: Extracted `src/kernel/workflow-engine.ts`, `src/workspace/change-set.ts` and `src/review/gates/release-gate.ts`; `src/index.ts` is 1295 lines after extraction.
- `2026-06-22`: Refactored authoritative event replay into an event-handler map; `npm run validate` passed.
- `2026-06-22`: Extracted governance commands into `src/ui/commands.ts`; `src/index.ts` is 1189 lines after extraction and `npm run validate` passed.
- `2026-06-22`: Runtime smoke: `pi --extension dist/index.js --tools goal_shell` executed `pwd` in `/tmp/pi-iterative-goal-tool-smoke-sbtswS` with exit code 0 and no tracked file changes.
- `2026-06-22`: Runtime smoke: `/goal-start` in `/tmp/pi-iterative-goal-start-smoke-CJatWs` registered commands/tools, captured capabilities, started `research`, and recorded a nonce-matched research artifact; no tracked file changes occurred.
- `2026-06-22`: Runtime smoke: pre-PR authorization remained absent (`releaseAuthorization: null`) before evaluator/release gates.
- `2026-06-22`: Model verification: `pi --list-models` found all 13 configured OpenRouter slugs; `pi --version` started cleanly.
- `2026-06-22`: Policy hardening: `PolicyEngine` now calls `resolveContainedPath()` for `fs.write`/`fs.delete`; smoke test 15 denies a write under a repo-local symlink to an external directory.
- `2026-06-22`: Release-flow runtime smoke: seeded a paused valid run in `/tmp/pi-iterative-goal-pr-dryrun-bhTPRK`; Pi loaded the extension and `goal_git create_pr` with `dryRun:true` authorized the exact ReleaseAuthorization and rendered a structured PR body without opening a PR.
- `2026-06-22`: Git policy slice: `goal_git` now creates `ActionRequest`-style policy decisions for git branch/stage/commit/push/PR effects; `npm run validate` passed.
- `2026-06-22`: Plan amendment slice: typed accepted amendments can broaden path scope; proposed/unreviewed amendments do not. `npm run validate` passed.
- `2026-06-22`: Agent isolation slice: isolated writer worktree patch capture, cleanup, overlap checks and schema validation are covered by smoke test 16.
- `2026-06-22`: Validation-gate slice: smoke test 5 now executes generated validation scripts in temporary git repositories; success returns 0 with PASS/PASS evidence, gate failure returns the gate exit code with per-check JSONL evidence, and missing mandatory commands return 1 with FAIL/FAIL evidence. `npm run validate` passed.
- `2026-06-22`: Capability-contract slice: added provider-neutral capability manifests and broker output schema validation; smoke test 15 proves invalid provider output is rejected after policy approval. `npm run validate` passed.
- `2026-06-22`: Event-log slice: new events include monotonic sequence, previous event hash and current event hash; replay verifies the chain and fails closed on tampering while retaining legacy unchained-log compatibility. `npm run validate` passed.
- `2026-06-22`: UI-tools extraction slice: moved core Pi tools and stale-write tool guard into `src/ui/tools.ts`; `src/index.ts` is 966 lines after extraction and `npm run validate` passed.
- `2026-06-22`: AWS capability slice: `goal_aws_cli` preflight and command execution now route process execution through `CapabilityBroker`/`PolicyEngine`; smoke test 11 invokes the registered tool with a mocked AWS CLI and verifies broker policy evidence. `npm run validate` passed.
- `2026-06-22`: Provider-contract slice: added runtime capability manifest validation and a registry; smoke test 15 rejects duplicate providers and invalid network manifests while accepting a valid provider contract. `npm run validate` passed.
- `2026-06-22`: Tool-interception extraction slice: moved bash interception and process policy checks into `src/ui/tool-interception.ts`; `src/index.ts` is 912 lines after extraction and `npm run validate` passed.
- `2026-06-22`: Filesystem-provider slice: added a brokered filesystem provider for read/write/delete manifests; smoke test 15 verifies allowed writes persist and out-of-scope writes are denied without touching disk. `npm run validate` passed.
- `2026-06-22`: Fresh Pi runtime smoke: `pi --extension dist/index.js --no-builtin-tools --tools goal_shell --no-session -p --model openrouter/deepseek/deepseek-v4-flash` executed `pwd` through `goal_shell` in `/tmp/pi-iterative-goal-tool-smoke-F7ppUF`; disposable git status remained clean.
- `2026-06-22`: Commit discipline: branch `refactor/autonomous-kernel-p0-p1` now contains scoped commits for validation gates, provider contracts, AWS, filesystem, event replay, release authorization, agent isolation, path scopes and UI extraction.
- `2026-06-22`: Goal-command extraction slice: moved `/goal-start`, `/goal-status`, pause/resume, repair, finalize and reset command handlers into `src/ui/goal-commands.ts`; `src/index.ts` is 597 lines after extraction and `npm run validate` passed.
- `2026-06-22`: Output-synthesis extraction slice: moved assistant text/tool-call synthesis helpers into `src/kernel/output-synthesis.ts` and re-exported them from `src/index.ts`; `src/index.ts` is 477 lines after extraction and `npm run validate` passed.
- `2026-06-22`: Subagent broker slice: `goal_subagent` now wraps `PiSubprocessAgentPool.submit()` in `CapabilityBroker`/`PolicyEngine` process execution decisions and converts allowed paths into typed path scopes before policy evaluation. `npm run validate` passed.
- `2026-06-22`: Lifecycle extraction slice: moved `agent_end`, session restore/shutdown/compaction handling and phase transition orchestration into `src/kernel/lifecycle.ts`; `src/index.ts` is 139 lines and `npm run validate` passed.
- `2026-06-22`: CLI capability slice: added `src/capabilities/process/provider.ts`, centralized package-install denial under `policy.package.install`, moved debug logging to `.pi/iterative-goal/debug.log` or `PI_ITERATIVE_GOAL_DEBUG_LOG`, and replaced project-specific AWS profile defaults with explicit/env/configured profile resolution. `npm run validate` passed.
- Review artifacts: `ai_docs/reviews/adversarial-slice-001-findings.json`, `ai_docs/reviews/ousterhout-slice-001-findings.json`, `ai_docs/reviews/adversarial-slice-002-findings.json`, `ai_docs/reviews/release-flow-slice-findings.json`, `ai_docs/reviews/git-policy-slice-findings.json`, `ai_docs/reviews/plan-amendment-slice-findings.json`, `ai_docs/reviews/agent-isolation-slice-findings.json`, `ai_docs/reviews/capability-persistence-slice-findings.json`, `ai_docs/reviews/ousterhout-capability-slice-findings.json`.
