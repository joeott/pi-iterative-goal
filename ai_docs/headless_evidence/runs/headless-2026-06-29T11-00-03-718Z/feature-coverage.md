# Headless Feature Evidence Report

Run ID: `headless-2026-06-29T11-00-03-718Z`
Trace ID: `386bbd16-0687-43cd-8c46-fcd317621e8c`
Commit: `94bea044275dd6e5ed33b24c353fb3ac7ceeb0db`
Generated: 2026-06-29T11:00:16.982Z

## Safety Boundary

- Secret values printed: no
- Cloud mutation attempted: no
- Write tests: disposable temp repositories only
- Expected AWS project account: `371292405073`
- Trace sink: local JSONL Langfuse-equivalent

## Check Summary

- Passed checks: 6
- Failed checks: 0
- Trace: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/trace.jsonl`

## Feature Coverage

| Feature | Status | Requirement | Evidence |
| --- | --- | --- | --- |
| `repo_instruction_loading` | PASS | Repo instruction loading from AGENTS.md/CLAUDE.md | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `planning` | PASS | Phase prompt planning and plan artifact handling | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `task_tracking` | PASS | Durable task tracking across phases and replay | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `tool_use` | PASS | Registered command/tool inventory and tool invocation | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `repo_search_read_edit_flows` | PASS | Repo search/read plus policy-brokered edit flows | `extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `shell_execution` | PASS | Guarded shell execution | `extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `subagent_worktree_isolation` | PASS | Subagent fallback and writer isolation policy | `extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `evaluator_gating` | PASS | External evaluator-only completion gate | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `approval_flows` | PASS | Explicit cyber approval request/resolve flow | `extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `model_fallback` | PASS | Allowed model fallback and direct Z.ai provider path | `smoke-tests` PASS<br>`zai-live-probe` PASS<br>`workload-benchmark` PASS |
| `resumability` | PASS | Session/disk replay and status restore | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `compaction_recovery` | PASS | Append-entry and latest state recovery surfaces | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `git_finalization` | PASS | Guarded git finalization and release authorization | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `aws_integration` | PASS | AWS profile/account/region policy and Secrets Manager metadata handling | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `dlp` | PASS | DLP secret scanning and redaction | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `indirect_prompt_injection` | PASS | Indirect prompt-injection delimiting | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `sandboxing` | PASS | Sandbox/capability policy fail-closed behavior | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `signing_attestation` | PASS | Signed evidence attestations | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `secrets_manager_handling` | PASS | Provider-token materialization and AWS Secrets Manager persistence controls | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `cas_unify_policy` | PASS | CAS/Unify Nemotron route enforcement and deprecated OCR route blocking | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `headless_cli` | PASS | Reproducible headless CLI validation | `build` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `glm52_live` | PASS | Live Z.ai GLM-5.2 responsiveness | `zai-live-probe` PASS |
| `tracing` | PASS | Trace/evaluation logging equivalent to Langfuse for local runs | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`local-trace-artifact` PASS<br>`derived-tracing` PASS |
| `coverage_report` | PASS | Feature-by-feature coverage report | `derived-coverage_report` PASS |
| `realistic_workloads` | PASS | Representative coding-agent workloads, not only static unit checks | `workload-benchmark` PASS |

## Explicit Remaining Gaps

None in this run.

## Checks

### build

Status: PASS

TypeScript build completes for current source

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/build.json`

### smoke-tests

Status: PASS

Static and adapter smoke tests pass

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/smoke-tests.json`

### zai-live-probe

Status: PASS

Live Z.ai GLM-5.2 endpoint responds headlessly

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/zai-live-probe.json`

### extension-headless-flow

Status: PASS

Extension tools and commands run in a disposable headless Pi harness

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/extension-headless-flow.json`

### workload-benchmark

Status: PASS

Representative coding-agent workloads satisfy Claude Code-style expectations

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/workload-benchmark.json`

### local-trace-artifact

Status: PASS

Local JSONL trace captures run decisions, latency, outputs, and failures

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-00-03-718Z/local-trace-artifact.json`
