# Headless Feature Evidence Report

Run ID: `headless-2026-06-29T11-07-34-975Z`
Trace ID: `f6402286-1908-4ab3-a458-100e1ca70d72`
Commit: `7c4b1c8e6727d0d8ebb6cff080361d4d7afb46ce`
Generated: 2026-06-29T11:07:47.951Z

## Safety Boundary

- Secret values printed: no
- Cloud mutation attempted: no
- Write tests: disposable temp repositories only
- Expected AWS control/payment account: `371292405073`
- Expected AWS project sub-account: `138881449763`
- Trace sink: local JSONL Langfuse-equivalent

## Check Summary

- Passed checks: 7
- Failed checks: 0
- Trace: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/trace.jsonl`

## Feature Coverage

| Feature | Status | Requirement | Evidence |
| --- | --- | --- | --- |
| `repo_instruction_loading` | PASS | Repo instruction loading from AGENTS.md/CLAUDE.md | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `planning` | PASS | Phase prompt planning and plan artifact handling | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `task_tracking` | PASS | Durable task tracking across phases and replay | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `tool_use` | PASS | Registered command/tool inventory and tool invocation | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `repo_search_read_edit_flows` | PASS | Repo search/read plus policy-brokered edit flows | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `shell_execution` | PASS | Guarded shell execution | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `subagent_worktree_isolation` | PASS | Subagent fallback and writer isolation policy | `extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `evaluator_gating` | PASS | External evaluator-only completion gate | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `approval_flows` | PASS | Explicit cyber approval request/resolve flow | `extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `model_fallback` | PASS | Allowed model fallback and direct Z.ai provider path | `smoke-tests` PASS<br>`zai-live-probe` PASS<br>`workload-benchmark` PASS |
| `resumability` | PASS | Session/disk replay and status restore | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `compaction_recovery` | PASS | Append-entry and latest state recovery surfaces | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `git_finalization` | PASS | Guarded git finalization and release authorization | `smoke-tests` PASS<br>`workload-benchmark` PASS |
| `aws_integration` | PASS | AWS profile/account/region policy and Secrets Manager metadata handling | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `dlp` | PASS | DLP secret scanning and redaction | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `indirect_prompt_injection` | PASS | Indirect prompt-injection delimiting | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `sandboxing` | PASS | Sandbox/capability policy fail-closed behavior | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `signing_attestation` | PASS | Signed evidence attestations | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `secrets_manager_handling` | PASS | Provider-token materialization and AWS Secrets Manager persistence controls | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `cas_unify_policy` | PASS | CAS/Unify Nemotron route enforcement and deprecated OCR route blocking | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS |
| `headless_cli` | PASS | Reproducible headless CLI validation | `build` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `glm52_live` | PASS | Live Z.ai GLM-5.2 responsiveness | `zai-live-probe` PASS |
| `tracing` | PASS | Trace/evaluation logging equivalent to Langfuse for local runs | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`local-trace-artifact` PASS<br>`derived-tracing` PASS |
| `coverage_report` | PASS | Feature-by-feature coverage report | `derived-coverage_report` PASS |
| `realistic_workloads` | PASS | Representative coding-agent workloads, not only static unit checks | `workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS |
| `vulnerability_remediation` | PASS | Headless vulnerability-hunting and remediation workload | `vulnerability-remediation-workload` PASS |

## Explicit Remaining Gaps

None in this run.

## Checks

### build

Status: PASS

TypeScript build completes for current source

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/build.json`

### smoke-tests

Status: PASS

Static and adapter smoke tests pass

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/smoke-tests.json`

### zai-live-probe

Status: PASS

Live Z.ai GLM-5.2 endpoint responds headlessly

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/zai-live-probe.json`

### extension-headless-flow

Status: PASS

Extension tools and commands run in a disposable headless Pi harness

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/extension-headless-flow.json`

### workload-benchmark

Status: PASS

Representative coding-agent workloads satisfy Claude Code-style expectations

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/workload-benchmark.json`

### vulnerability-remediation-workload

Status: PASS

Headless CLI remediates representative security vulnerabilities with tests and attestations

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/vulnerability-remediation-workload.json`

### local-trace-artifact

Status: PASS

Local JSONL trace captures run decisions, latency, outputs, and failures

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-07-34-975Z/local-trace-artifact.json`
