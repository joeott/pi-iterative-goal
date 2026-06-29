# Headless Feature Evidence Report

Run ID: `headless-2026-06-29T10-41-51-327Z`
Trace ID: `35005f56-1965-4dda-b83e-686648f5410f`
Commit: `70f66209cc8b4ee092af50269b257538322f5f35`
Generated: 2026-06-29T10:42:03.115Z

## Safety Boundary

- Secret values printed: no
- Cloud mutation attempted: no
- Write tests: disposable temp repositories only
- Expected AWS project account: `371292405073`
- Trace sink: local JSONL Langfuse-equivalent

## Check Summary

- Passed checks: 5
- Failed checks: 0
- Trace: `ai_docs/headless_evidence/runs/headless-2026-06-29T10-41-51-327Z/trace.jsonl`

## Feature Coverage

| Feature | Status | Requirement | Evidence |
| --- | --- | --- | --- |
| `repo_instruction_loading` | PASS | Repo instruction loading from AGENTS.md/CLAUDE.md | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `planning` | PASS | Phase prompt planning and plan artifact handling | `smoke-tests` PASS |
| `task_tracking` | PASS | Durable task tracking across phases and replay | `smoke-tests` PASS |
| `tool_use` | PASS | Registered command/tool inventory and tool invocation | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `repo_search_read_edit_flows` | PASS | Repo search/read plus policy-brokered edit flows | `extension-headless-flow` PASS |
| `shell_execution` | PASS | Guarded shell execution | `extension-headless-flow` PASS |
| `subagent_worktree_isolation` | PASS | Subagent fallback and writer isolation policy | `extension-headless-flow` PASS |
| `evaluator_gating` | PASS | External evaluator-only completion gate | `smoke-tests` PASS |
| `approval_flows` | PASS | Explicit cyber approval request/resolve flow | `extension-headless-flow` PASS |
| `model_fallback` | PASS | Allowed model fallback and direct Z.ai provider path | `smoke-tests` PASS<br>`zai-live-probe` PASS |
| `resumability` | PASS | Session/disk replay and status restore | `smoke-tests` PASS |
| `compaction_recovery` | PASS | Append-entry and latest state recovery surfaces | `smoke-tests` PASS |
| `git_finalization` | PASS | Guarded git finalization and release authorization | `smoke-tests` PASS |
| `aws_integration` | PASS | AWS profile/account/region policy and Secrets Manager metadata handling | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `dlp` | PASS | DLP secret scanning and redaction | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `indirect_prompt_injection` | PASS | Indirect prompt-injection delimiting | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `sandboxing` | PASS | Sandbox/capability policy fail-closed behavior | `smoke-tests` PASS |
| `signing_attestation` | PASS | Signed evidence attestations | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `secrets_manager_handling` | PASS | Provider-token materialization and AWS Secrets Manager persistence controls | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `cas_unify_policy` | PASS | CAS/Unify Nemotron route enforcement and deprecated OCR route blocking | `smoke-tests` PASS<br>`extension-headless-flow` PASS |
| `headless_cli` | PASS | Reproducible headless CLI validation | `build` PASS<br>`extension-headless-flow` PASS |
| `glm52_live` | PASS | Live Z.ai GLM-5.2 responsiveness | `zai-live-probe` PASS |
| `tracing` | PASS | Trace/evaluation logging equivalent to Langfuse for local runs | `extension-headless-flow` PASS<br>`local-trace-artifact` PASS<br>`derived-tracing` PASS |
| `coverage_report` | PASS | Feature-by-feature coverage report | `derived-coverage_report` PASS |
| `realistic_workloads` | WARN | Representative coding-agent workloads, not only static unit checks | `derived-realistic_workloads` WARN |

## Explicit Remaining Gaps

- `realistic_workloads`: Current evidence covers representative harness flows and live GLM-5.2 responsiveness, but not a sustained autonomous coding workload benchmark against Claude Code-style expectations.

## Checks

### build

Status: PASS

TypeScript build completes for current source

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T10-41-51-327Z/build.json`

### smoke-tests

Status: PASS

Static and adapter smoke tests pass

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T10-41-51-327Z/smoke-tests.json`

### zai-live-probe

Status: PASS

Live Z.ai GLM-5.2 endpoint responds headlessly

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T10-41-51-327Z/zai-live-probe.json`

### extension-headless-flow

Status: PASS

Extension tools and commands run in a disposable headless Pi harness

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T10-41-51-327Z/extension-headless-flow.json`

### local-trace-artifact

Status: PASS

Local JSONL trace captures run decisions, latency, outputs, and failures

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T10-41-51-327Z/local-trace-artifact.json`
