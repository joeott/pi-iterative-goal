# pi-iterative-goal Specification

## 1. Product Overview
`pi-iterative-goal` is a Pi Coding Agent extension that implements an autonomous
supervisor loop for durable goal-seeking. It never voluntarily stops until an
external evaluator returns `goal_met: true`.

### Why it exists
LLMs try to self-certify completion, hallucinate unavailable tools, and need
constant re-prompting. This extension acts as a durable supervisor that:
- Owns the loop (agent_end → next phase → sendUserMessage)
- Classifies errors and routes around them
- Enforces evaluator-only completion
- Survives restarts and context compaction

## 2. Architecture

### Four-Phase Loop
```
research → plan → implement → validate → external evaluator
    ↑                                          |
    └──────────── goal_met=false ──────────────┘
```

Every cycle runs all four phases, even if phases fail. Failures become
phase artifacts that the evaluator reviews.

### Loop Motor
- `agent_end` fires → extract/synthesize phase result → advance phase → sendUserMessage(..., { deliverAs: "followUp" })
- The extension never trusts the LLM to continue on its own
- `session_start` restores durable state and resumes if running

### Error Classification
```
tool_missing:bash → Use goal_shell / pi.exec; continue
tool_missing:subagent → Single-agent fallback; continue
mcp_server_missing → Remove from MCP plan; continue
provider_tool_route_incompatible → Switch model; retry
dependency_missing → Create blocker; continue to Validate
dirty_worktree → Do not mutate; evaluator recovery
ci_failure → Loop back to Research with CI logs
```

### Capability Preflight
Before every phase, the extension takes a snapshot of:
- Available tools (getAllTools / getActiveTools)
- Registered commands (getCommands)
- MCP servers (detected from tool sources)
- Subagent backend (subagent tool, Agent tool, command, or none)
- Applicable project instruction files (`AGENTS.md`, `CLAUDE.md`) from repo root
  to the current working directory

This is injected into the phase prompt so the model never hallucinates
unavailable tools.

### External Evaluator
A separate model call assesses whether the goal is met. The evaluator:
- Reviews evidence from all four phases
- Must explicitly return `goal_met: true` for the loop to stop
- Returns strict JSON with blockers, accepted/rejected evidence, remaining work
- Has fallback behavior when the evaluator model is unavailable (defaults to goal_met=false)

### Safety
- `goal_shell` tool backed by `pi.exec()` with allowlists/blocklists
- Always-blocked patterns (rm -rf /, DROP TABLE, terraform destroy)
- Destructive patterns blocked unless allowDestructiveOps is true
- `tool_call` event handler blocks dangerous bash commands

### Persistence
Three-layer persistence:
1. Session-level: `pi.appendEntry()` checkpoints (survive sessions)
2. Disk: `.pi/iterative-goal/state.json`, `events.jsonl` (survive compaction)
3. Human-readable: `.pi/iterative-goal/latest.md` (quick inspection)

## 3. Extension Commands

| Command | Description |
|---------|-------------|
| `/goal-start <goal>` | Start autonomous goal loop. Use `#criterion:` for explicit criteria |
| `/goal-status` | Show current state, cycle, phase, evaluator verdict |
| `/goal-dashboard` | TUI dashboard with cycle/phase/blockers/errors |
| `/goal-pause` | Pause the loop (the ONLY normal way to stop) |
| `/goal-resume` | Resume a paused loop |
| `/goal-repair-capabilities` | Run capability preflight and attempt fixes |
| `/goal-reset` | Clear state and stop |

## 4. Extension Tools

| Tool | Description |
|------|-------------|
| `goal_report_phase_result` | MANDATORY: Report phase completion (research/plan/implement/validate) |
| `goal_record_blocker` | Record a blocker that prevents progress |
| `goal_request_capability_repair` | Request tool/model restoration |
| `goal_shell` | Safe shell execution with allowlists |
| `goal_repo_context` | Read, list, or search repo files with containment, DLP/IPI processing, and attestation |
| `goal_subagent` | Subagent delegation with backend detection |
| `goal_update_task_plan` | Maintain durable task checklist across phases, compaction, and evaluator cycles |
| `goal_checkpoint` | Force state checkpoint |

## 4.1 Model Provider Runtime

The harness supports a gitignored local `.env` for model-provider tokens and a
mirrored AWS Secrets Manager bundle for AWS runtime use. The AWS account split is
explicit: the control account owns payments/provider billing, while the project
account is the workload sub-account.

- Local materialization: `npm run env:models -- --operator-approved-local-secret-materialization`
- AWS persistence, control/payment account: add `--operator-approved-aws-secrets-manager-write --aws-scope control --control-aws-profile unify-old --expected-control-aws-account 371292405073`
- AWS persistence, both accounts: add `--operator-approved-aws-secrets-manager-write --aws-scope both --control-aws-profile unify-old --expected-control-aws-account 371292405073 --project-aws-profile api-admin --expected-project-aws-account 138881449763`
- Default secret name: `pi-iterative-goal/model-provider-tokens`
- Secret values are never printed; status output reports key names only.

Z.ai GLM 5.2 is registered dynamically as:

- Provider: `zai`
- Model: `glm-5.2`
- Base URL: `https://api.z.ai/api/coding/paas/v4`
- API: OpenAI-compatible chat completions
- Headless probe: `npm run probe:zai`

## 4.2 Headless Evidence and Tracing

The harness includes a reproducible headless evidence runner:

```bash
npm run evidence:headless
```

The runner builds the extension, runs the smoke suite, probes live Z.ai
GLM 5.2, loads the extension through a fake Pi API, exercises representative
command/tool flows, representative coding workloads, and vulnerability
remediation workloads in disposable git repositories, and writes local
Langfuse-equivalent trace artifacts:

- `ai_docs/headless_evidence/latest-feature-coverage.md`
- `ai_docs/headless_evidence/latest-feature-coverage.json`
- `ai_docs/headless_evidence/runs/<run-id>/trace.jsonl`

The coverage report maps objective-level capabilities to concrete evidence and
keeps explicit remaining gaps. Generated traces redact common secret patterns
and the runner uses temp repositories for write tests.

The vulnerability remediation workload proves the cyber-defense path by starting
from failing tests for reflected XSS, path traversal, and implementation
disclosure, applying a scoped fix through the harness policy layer, then rerunning
the security tests and recording signed evidence.

## 5. Data Model

```typescript
interface IterativeGoalState {
  version: 1;
  runId: string;
  goal: string;
  goalCriterion: string;
  mode: "auto_until_external_evaluator_success";
  status: "running" | "paused_by_user" | "recovering" | "succeeded";
  cycle: number;
  phase: "research" | "plan" | "implement" | "validate";
  evaluator: { model, provider, lastVerdict? };
  capabilities: CapabilitySnapshot | null;
  projectInstructions: {
    discoveredAt: string | null;
    repoRoot: string | null;
    cwd: string | null;
    files: Array<{
      path: string;
      filename: "AGENTS.md" | "CLAUDE.md";
      sha256: string;
      bytes: number;
      content: string;
      truncated: boolean;
      precedence: number;
    }>;
  };
  errors: IterativeGoalError[];
  artifacts: {
    research: PhaseArtifact[];
    plans: PhaseArtifact[];
    implementations: PhaseArtifact[];
    validations: PhaseArtifact[];
    evaluatorReports: EvaluatorVerdict[];
  };
  taskPlan: {
    updatedAt: string | null;
    updatedByPhaseAttemptId: string | null;
    rationale: string | null;
    items: Array<{
      id: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
      detail: string | null;
      evidence: string[];
      updatedAt: string;
    }>;
  };
  constraints: {
    neverStopUntilEvaluatorGoalMet: true;
    requireAllFourPhasesEachCycle: true;
    allowDestructiveOps: false;
    requireOperatorApprovalForDangerousOps: true;
  };
}
```

## 6. Evaluator Verdict Schema

```typescript
interface EvaluatorVerdict {
  goal_met: boolean;
  confidence: number;       // 0-1
  completion_blockers: string[];
  accepted_evidence: string[];
  rejected_evidence: string[];
  remaining_work: Array<{
    priority: "critical" | "high" | "medium" | "low";
    description: string;
  }>;
  next_cycle_directive: {
    focus: "research" | "plan" | "implement" | "validate" | "capability_repair";
    reason: string;
  };
  safety_notes: string[];
}
```

## 7. File Structure

```
src/
  index.ts          - Main extension: loop motor, tools, commands, hooks
  types.ts          - All TypeScript types and TypeBox schemas
  state.ts          - StateManager: create, persist, restore, clear
  phases.ts         - Phase prompt generation (research/plan/implement/validate)
  evaluator.ts      - External evaluator: model call, parsing, fallback
  capabilities.ts   - Capability snapshot, namespace separation, subagent detection
  errors.ts         - Error classifier and recovery transitions
  safety.ts         - Command allowlists/blocklists
  shell.ts          - goal_shell tool (pi.exec with safety)
  subagents.ts      - goal_subagent tool (backend detection + fallback)
  dashboard.ts      - TUI dashboard component and commands
```

Project runtime files:
```
.pi/iterative-goal/
  state.json         - Machine-readable state
  events.jsonl       - Append-only event log
  latest.md          - Human-readable summary
  task-plan.jsonl    - Durable task-plan update audit trail
  evaluator-verdicts.jsonl - Evaluator verdicts
```
