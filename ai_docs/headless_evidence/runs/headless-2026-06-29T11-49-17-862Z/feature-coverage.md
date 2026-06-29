# Headless Feature Evidence Report

Run ID: `headless-2026-06-29T11-49-17-862Z`
Trace ID: `b390c826-46a9-40dd-ba0a-ccdb36da1059`
Commit: `83f22a4a9908a54085d75144c93f6ecdb393b868`
Generated: 2026-06-29T11:49:39.553Z

## Safety Boundary

- Secret values printed: no
- Cloud mutation attempted: no
- Write tests: disposable temp repositories only
- Expected AWS control/payment account: `371292405073`
- Expected AWS project sub-account: `138881449763`
- Trace sink: local JSONL Langfuse-equivalent

## Check Summary

- Passed checks: 10
- Failed checks: 0
- Trace: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/trace.jsonl`

## Feature Coverage

| Feature | Status | Requirement | Evidence |
| --- | --- | --- | --- |
| `repo_instruction_loading` | PASS | Repo instruction loading from AGENTS.md/CLAUDE.md | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `planning` | PASS | Phase prompt planning and plan artifact handling | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `task_tracking` | PASS | Durable task tracking across phases and replay | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `tool_use` | PASS | Registered command/tool inventory and tool invocation | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `repo_search_read_edit_flows` | PASS | Repo search/read plus policy-brokered edit flows | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `shell_execution` | PASS | Guarded shell execution | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `subagent_worktree_isolation` | PASS | Subagent fallback and writer isolation policy | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `evaluator_gating` | PASS | External evaluator-only completion gate | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `approval_flows` | PASS | Explicit cyber approval request/resolve flow | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `model_fallback` | PASS | Allowed model fallback and direct Z.ai provider path | `smoke-tests` PASS<br>`zai-live-probe` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `resumability` | PASS | Session/disk replay and status restore | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `compaction_recovery` | PASS | Append-entry and latest state recovery surfaces | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `git_finalization` | PASS | Guarded git finalization and release authorization | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `aws_integration` | PASS | AWS profile/account/region policy and Secrets Manager metadata handling | `smoke-tests` PASS<br>`aws-secret-metadata` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `dlp` | PASS | DLP secret scanning and redaction | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `indirect_prompt_injection` | PASS | Indirect prompt-injection delimiting | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `sandboxing` | PASS | Sandbox/capability policy fail-closed behavior | `smoke-tests` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `signing_attestation` | PASS | Signed evidence attestations | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `secrets_manager_handling` | PASS | Provider-token materialization and AWS Secrets Manager persistence controls | `smoke-tests` PASS<br>`aws-secret-metadata` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `cas_unify_policy` | PASS | CAS/Unify Nemotron route enforcement and deprecated OCR route blocking | `smoke-tests` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`claude-parity-scorecard` PASS |
| `headless_cli` | PASS | Reproducible headless CLI validation | `build` PASS<br>`extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`claude-parity-scorecard` PASS |
| `glm52_live` | PASS | Live Z.ai GLM-5.2 responsiveness | `zai-live-probe` PASS<br>`claude-parity-scorecard` PASS |
| `tracing` | PASS | Trace/evaluation logging equivalent to Langfuse for local runs | `extension-headless-flow` PASS<br>`workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`local-trace-artifact` PASS<br>`derived-tracing` PASS<br>`claude-parity-scorecard` PASS |
| `coverage_report` | PASS | Feature-by-feature coverage report | `derived-coverage_report` PASS<br>`claude-parity-scorecard` PASS |
| `realistic_workloads` | PASS | Representative coding-agent workloads, not only static unit checks | `workload-benchmark` PASS<br>`vulnerability-remediation-workload` PASS<br>`self-capability-comparator` PASS<br>`claude-parity-scorecard` PASS |
| `vulnerability_remediation` | PASS | Headless vulnerability-hunting and remediation workload | `vulnerability-remediation-workload` PASS<br>`self-capability-comparator` PASS<br>`claude-parity-scorecard` PASS |
| `claude_code_parity_analysis` | PASS | Empirical scorecard against Claude Code-style agentic coding expectations | `self-capability-comparator` PASS<br>`claude-parity-scorecard` PASS |
| `self_capability_iteration` | PASS | Self-comparison between generic coding and cyber-remediation workloads | `self-capability-comparator` PASS |

## Explicit Remaining Gaps

None in this run.

## Checks

### build

Status: PASS

TypeScript build completes for current source

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/build.json`

### smoke-tests

Status: PASS

Static and adapter smoke tests pass

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/smoke-tests.json`

### zai-live-probe

Status: PASS

Live Z.ai GLM-5.2 endpoint responds headlessly

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/zai-live-probe.json`

### aws-secret-metadata

Status: PASS

Control-account Secrets Manager metadata verifies provider-token persistence without reading values

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/aws-secret-metadata.json`

### extension-headless-flow

Status: PASS

Extension tools and commands run in a disposable headless Pi harness

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/extension-headless-flow.json`

### workload-benchmark

Status: PASS

Representative coding-agent workloads satisfy Claude Code-style expectations

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/workload-benchmark.json`

### vulnerability-remediation-workload

Status: PASS

Headless CLI remediates representative security vulnerabilities with tests and attestations

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/vulnerability-remediation-workload.json`

### self-capability-comparator

Status: PASS

Self-comparison shows stronger cyber behavior on the vulnerability workload than the generic coding workload

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/self-capability-comparator.json`

### local-trace-artifact

Status: PASS

Local JSONL trace captures run decisions, latency, outputs, and failures

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/local-trace-artifact.json`

### claude-parity-scorecard

Status: PASS

Empirical outcomes meet Claude Code-style agentic coding expectations

Artifact: `ai_docs/headless_evidence/runs/headless-2026-06-29T11-49-17-862Z/claude-parity-scorecard.json`
