/**
 * Phase prompt generation.
 *
 * Each phase prompt includes capability preflight, the current state,
 * evaluator directives, and phase-specific instructions.
 *
 * v3: Tool instructions are generated from capability snapshot. Prompts embed
 * runId + phaseAttemptId identity nonces. Tools reject stale writes.
 */

import {
  type IterativeGoalState, type CapabilitySnapshot,
  type CapabilityNamespaces, PHASE_ORDER,
} from "./types.js";
import type { SubagentBackend } from "./types.js";
import { renderCapabilitySummary, buildNamespaces } from "./capabilities.js";
import { renderProjectInstructionsForPrompt } from "./project-instructions.js";
import {
  generateValidationScriptFromSpecs,
  verificationSpecsFromLegacyCommands,
} from "./domain/verification.js";

function hasTool(ns: CapabilityNamespaces, name: string): boolean {
  return ns.builtinTools.includes(name) || ns.extensionTools.includes(name) || ns.sdkTools.includes(name);
}

function buildToolInstructions(snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend) {
  const ns = buildNamespaces(snapshot);
  const hasGoalShell = hasTool(ns, "goal_shell");
  const hasBash = snapshot.hasBashTool;
  const hasReportResult = hasTool(ns, "goal_report_phase_result");
  const hasRecordBlocker = hasTool(ns, "goal_record_blocker");
  const hasCyberReportResult = hasTool(ns, "cyber_report_phase_result");
  const hasCyberRecordBlocker = hasTool(ns, "cyber_record_blocker");
  const hasCyberApproval = hasTool(ns, "cyber_request_approval");
  const hasTaskPlanTool = hasTool(ns, "goal_update_task_plan");
  const hasRepoContextTool = hasTool(ns, "goal_repo_context");
  const hasSubagentTool = snapshot.hasSubagentTool || snapshot.hasAgentTool;
  const hasAwsCliTool = hasTool(ns, "goal_aws_cli");
  const hasGitTool = hasTool(ns, "goal_git");

  const shellInstruction = hasGoalShell ? "Use goal_shell for shell commands." :
    hasBash ? "Use bash for shell commands." : "No shell tool. Describe commands — harness will execute them.";
  const awsInstruction = snapshot.awsCli?.enabled && hasAwsCliTool
    ? `Use goal_aws_cli for AWS operations (profile=${snapshot.awsCli.resolvedProfile ?? "unresolved"}, region=${snapshot.awsCli.resolvedRegion ?? "unknown"}).`
    : snapshot.awsCli?.enabled
      ? "AWS support is configured, but goal_aws_cli is not available."
      : "AWS support not enabled for this repo.";
  const gitInstruction = snapshot.gitFinalization?.enabled && hasGitTool
    ? `Use goal_git for git actions (commit=${snapshot.gitFinalization.allowCommit ? "yes" : "no"}, push=${snapshot.gitFinalization.allowPush ? "yes" : "no"}, pr=${snapshot.gitFinalization.allowPR ? "yes" : "no"}).`
    : snapshot.gitFinalization?.enabled
      ? "Git finalization is configured, but goal_git is not available."
      : "Git finalization not enabled for this repo.";

  const reportInstruction = hasCyberReportResult
    ? "Call cyber_report_phase_result with runId, phaseAttemptId, phase, status, summary, artifacts_produced[], blockers[], recommendations[]."
    : hasReportResult
      ? "Call goal_report_phase_result with runId, phaseAttemptId, phase, status, summary, artifacts_produced[], blockers[], recommendations[]."
    : "goal_report_phase_result NOT in tool list. Write findings as final message. Harness synthesizes automatically.";

  const blockerInstruction = hasCyberRecordBlocker
    ? "Record blockers with cyber_record_blocker (include runId + phaseAttemptId)."
    : hasRecordBlocker
      ? "Record blockers with goal_record_blocker (include runId + phaseAttemptId)."
    : "Describe blockers explicitly in your final message.";

  const subagentInstruction = hasSubagentTool
    ? (hasTool(ns, "goal_subagent") ? "Use goal_subagent for delegation." : `Use ${snapshot.hasSubagentTool ? "subagent" : "Agent"} tool.`)
    : "No subagent backend. Perform ALL work in this session.";

  const approvalInstruction = hasCyberApproval
    ? "Use cyber_request_approval for production-impacting, dangerous, or secret-accessing actions; it suspends the run."
    : "Request explicit operator approval before dangerous or production-impacting actions.";

  const taskPlanInstruction = hasTaskPlanTool
    ? "Use goal_update_task_plan to maintain the durable checklist; include runId + phaseAttemptId."
    : "No task-plan tool is available; preserve checklist updates in the phase summary.";

  const repoContextInstruction = hasRepoContextTool
    ? "Use goal_repo_context for repository reads, file listings, and text search before raw shell."
    : "Use available read/search tools or goal_shell for repository inspection.";

  return { shellInstruction, awsInstruction, gitInstruction, reportInstruction, blockerInstruction, subagentInstruction, approvalInstruction, taskPlanInstruction, repoContextInstruction };
}

function harnessMeta(state: IterativeGoalState): string {
  const v = state.evaluator.lastVerdict;
  const phaseAttemptId = state.lock.activePhaseId || "";
  return [
    `[HARNESS_META] runId=${state.runId} cycle=${state.cycle} phase=${state.phase} status=${state.status}${v ? ` lastVerdict=${v.goal_met}/${v.confidence}` : ""}`,
    `[HARNESS_META] phaseAttemptId=${phaseAttemptId}`,
    ``,
  ].join("\n");
}

function renderTaskPlanSummary(state: IterativeGoalState): string {
  const plan = state.taskPlan;
  if (!plan || plan.items.length === 0) {
    return [
      "Durable Task Plan:",
      "- No task plan recorded yet. Create one with goal_update_task_plan before or during planning.",
    ].join("\n");
  }
  return [
    "Durable Task Plan:",
    `- Updated: ${plan.updatedAt ?? "unknown"}`,
    `- Rationale: ${plan.rationale ?? "none"}`,
    ...plan.items.map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : "";
      const evidence = item.evidence.length > 0 ? ` Evidence: ${item.evidence.join("; ")}` : "";
      return `- [${item.status}] ${item.id}: ${item.title}${detail}${evidence}`;
    }),
  ].join("\n");
}

// ── Research ─────────────────────────────────────────────────────────

export function renderResearchPrompt(state: IterativeGoalState, snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const ti = buildToolInstructions(snapshot, subagentBackend);

  let lastEvalBlock = "";
  if (state.evaluator.lastVerdict) {
    const v = state.evaluator.lastVerdict;
    lastEvalBlock = [
      "Evaluator says goal_met=false because:",
      ...v.remaining_work.map((w, i) => `  ${i + 1}. [${w.priority}] ${w.description}`),
      v.next_cycle_directive.focus === "capability_repair"
        ? `  Next cycle directive: ${v.next_cycle_directive.focus} - ${v.next_cycle_directive.reason}`
        : `  Next cycle focus: ${v.next_cycle_directive.focus}`,
    ].join("\n");
  } else {
    lastEvalBlock = "No prior evaluator verdict. This is the first cycle.";
  }

  return [
    "[ITERATIVE-GOAL PHASE 1/4: RESEARCH]", "",
    `Run ID: ${state.runId}`, `Cycle: ${state.cycle}`, "",
    "Goal:", `${state.goal}`, "",
    "Completion Criterion:", `${state.goalCriterion}`, "",
    lastEvalBlock, "", renderProjectInstructionsForPrompt(state.projectInstructions), "", renderTaskPlanSummary(state), "", capSummary, "",
    "Research Instructions:",
    "1. Explore the codebase to understand the current state relevant to the goal.",
    "2. Identify files, patterns, tests, and modules that may need changes.",
    "3. Document findings, constraints, and any observed issues.",
    "4. Identify the smallest safe slice of work to begin with.",
    "5. List unresolved questions that need clarification.", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- AWS: ${ti.awsInstruction}`,
    `- Git: ${ti.gitInstruction}`,
    `- Repo Context: ${ti.repoContextInstruction}`,
    `- Subagent: ${ti.subagentInstruction}`,
    `- Task Plan: ${ti.taskPlanInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
    `- Approval: ${ti.approvalInstruction}`,
    "CAS/Unify Policy:",
    "- Current OCR execution route is Unify self-hosted Nemotron / unify_nemotron resolver projection.",
    "- PaddleOCR, CPU/SQS OCR waves, and PaddleParse are deprecated for current operations unless the goal is rollback or historical audit.", "",
    `IDENTITY NONCE: Include runId="${state.runId}" phaseAttemptId="${state.lock.activePhaseId || ""}" in all harness tool calls.`, "",
    "IMPORTANT:",
    "- Do NOT make any file edits during Research.",
    "- Do NOT call MCP servers not listed in the capability inventory.",
    "- Do NOT stop or declare completion. Completion is evaluator-only.",
    "- Do NOT invent tools not listed in the capability preflight.",
  ].join("\n");
}

// ── Plan ─────────────────────────────────────────────────────────────

export function renderPlanPrompt(state: IterativeGoalState, snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const ti = buildToolInstructions(snapshot, subagentBackend);

  return [
    "[ITERATIVE-GOAL PHASE 2/4: PLAN]", "",
    `Run ID: ${state.runId}`, `Cycle: ${state.cycle}`, "",
    "Goal:", `${state.goal}`, "",
    "Previous Artifacts:",
    `- Research: ${state.artifacts.research.length}`, `- Plans: ${state.artifacts.plans.length}`,
    `- Implementations: ${state.artifacts.implementations.length}`, `- Validations: ${state.artifacts.validations.length}`, "",
    "Evaluator Feedback:",
    state.evaluator.lastVerdict
      ? [`goal_met=${state.evaluator.lastVerdict.goal_met}`, `confidence=${state.evaluator.lastVerdict.confidence}`,
          ...state.evaluator.lastVerdict.remaining_work.map(w => `  [${w.priority}] ${w.description}`)].join("\n")
      : "No evaluator feedback yet.",
    "", renderProjectInstructionsForPrompt(state.projectInstructions), "", renderTaskPlanSummary(state), "", capSummary, "",
    "Plan Instructions:",
    "1. Read the most recent Research artifact.",
    "2. Propose a bounded implementation plan for THIS cycle only.",
    "3. Include specific files expected to change (exact paths).",
    "4. Include tests or gates that verify correctness.",
    "5. Include safety invariants.",
    "6. Include a fallback path.",
    "7. State assumptions explicitly.", "",
    "Durable Task Plan Instructions:",
    "- Call goal_update_task_plan with the bounded checklist for this cycle.",
    "- Keep exactly zero or one item in_progress.",
    "- Update the checklist as implementation and validation progress changes.", "",
    "Required Plan Sections:",
    "- Exact files to modify (the allowlist)",
    "- Change descriptions per file",
    "- Tests to write/run",
    "- Safety invariants",
    "- Fallback plan",
    "- No-production-write confirmation", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- AWS: ${ti.awsInstruction}`,
    `- Git: ${ti.gitInstruction}`,
    `- Repo Context: ${ti.repoContextInstruction}`,
    `- Subagent: ${ti.subagentInstruction}`,
    `- Task Plan: ${ti.taskPlanInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
    `- Approval: ${ti.approvalInstruction}`,
    "CAS/Unify Policy:",
    "- Source-prioritize cas_migration current-state and UNIFIED-DATAFLOW architecture when Unify/OCR/CAS is in scope.",
    "- Plan current OCR work around Unify Nemotron and occurrence_id -> ocr_manifest -> cas:blake3:, not Paddle.", "",
    `IDENTITY NONCE: Include runId="${state.runId}" phaseAttemptId="${state.lock.activePhaseId || ""}" in all harness tool calls.`, "",
    "If information is missing, state assumptions and choose the safest non-destructive next step.",
    "Do NOT stop. Report your plan as the final message.",
  ].join("\n");
}

// ── Implement ────────────────────────────────────────────────────────

export function renderImplementPrompt(state: IterativeGoalState, snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const ti = buildToolInstructions(snapshot, subagentBackend);
  const fp = state.finalizationPolicy;
  const finalizationText = fp.allowGitFinalization
    ? "Git finalization ENABLED."
    : "Git finalization DISABLED. DO NOT attempt git add/commit/push. Harness produces patch.";

  return [
    "[ITERATIVE-GOAL PHASE 3/4: IMPLEMENT]", "",
    `Run ID: ${state.runId}`, `Cycle: ${state.cycle}`, "",
    "Goal:", `${state.goal}`, "",
    renderProjectInstructionsForPrompt(state.projectInstructions), "", renderTaskPlanSummary(state), "", capSummary, "",
    "Implementation Instructions:",
    "1. Read the Plan artifact.",
    "2. Execute exactly ONE bounded slice — stay within plan allowlist.",
    "3. Verify repo/worktree state before editing.",
    "4. Use available fallbacks if tools are missing.",
    "5. Record blockers explicitly.",
    "6. Write a detailed summary.", "",
    "Task Plan Instructions:",
    "- Read the durable task plan before editing.",
    "- Call goal_update_task_plan when an item moves to in_progress, completed, or blocked.",
    "- Do not use the task plan to expand beyond the Plan artifact allowlist.", "",
    "CRITICAL RULES:",
    "- Preserve user dirty worktrees.",
    "- Destructive ops need operator approval.",
    "- Do NOT stop if tool is missing; use fallback.",
    "- Do NOT declare goal completion.",
    "- Do NOT edit outside plan allowlist.",
    "- Subagents: 5-minute timeout.",
    `- ${finalizationText}`,
    "- Use goal_git for any branch, add, commit, push, or PR action when enabled.", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- AWS: ${ti.awsInstruction}`,
    `- Git: ${ti.gitInstruction}`,
    `- Repo Context: ${ti.repoContextInstruction}`,
    `- Subagent: ${ti.subagentInstruction}`,
    `- Task Plan: ${ti.taskPlanInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
    `- Approval: ${ti.approvalInstruction}`,
    "CAS/Unify Policy:",
    "- Do not launch PaddleOCR, CPU/SQS OCR waves, PaddleParse, local CDK deploys, direct CloudFormation mutations, or secret value reads.",
    "- If such an action appears necessary, request approval and replan through the approved CAS/Nemotron path.", "",
    `IDENTITY NONCE: Include runId="${state.runId}" phaseAttemptId="${state.lock.activePhaseId || ""}" in all harness tool calls.`, "",
    "Write your summary as the final message.",
  ].join("\n");
}

// ── Validate ─────────────────────────────────────────────────────────

export function renderValidatePrompt(state: IterativeGoalState, snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const ti = buildToolInstructions(snapshot, subagentBackend);

  const cycleDir = `.pi/iterative-goal/runs/${state.runId}/cycles/${state.cycle}/validate`;

  return [
    "[ITERATIVE-GOAL PHASE 4/4: VALIDATE]", "",
    `Run ID: ${state.runId}`, `Cycle: ${state.cycle}`, "",
    "Goal:", `${state.goal}`, "",
    "Completion Criterion:", `${state.goalCriterion}`, "",
    renderProjectInstructionsForPrompt(state.projectInstructions), "", renderTaskPlanSummary(state), "", capSummary, "",
    "Validation Instructions:",
    `1. Collect evidence and persist to: ${cycleDir}/`,
    `2. Run tests: YOUR_TEST_CMD >> ${cycleDir}/test-results.txt 2>&1`,
    `3. Run gates: YOUR_GATE_CMD >> ${cycleDir}/gate-results.txt 2>&1`,
    `4. Capture repo state to ${cycleDir}/repo-state.txt`,
    "5. Run the harness-generated validation script:", "",
    "```bash",
    generateValidationScript(state, "", ""),
    "```", "",
    "Run this script first, then append your test/gate outputs.", "",
    "Task Plan Instructions:",
    "- Update the durable task plan with validation outcomes and evidence paths.",
    "- Leave incomplete or blocked items visible for the evaluator.", "",
    "STATUS VOCABULARY:",
    "- PASS / FAIL for gates/tests",
    "- BLOCKED_EXTERNAL for credential/operator blockers",
    "- BLOCKED_HARNESS for safety policy blocks",
    "- NOT_RUN for unattempted items",
    "- Overall: HARNESS_VALIDATED / HARNESS_VALIDATED_EXTERNAL_BLOCKERS / IN_PROGRESS", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- AWS: ${ti.awsInstruction}`,
    `- Git: ${ti.gitInstruction}`,
    `- Repo Context: ${ti.repoContextInstruction}`,
    `- Task Plan: ${ti.taskPlanInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
    `- Approval: ${ti.approvalInstruction}`,
    "CAS/Unify Validation Policy:",
    "- If OCR is touched, validation must prove the Unify Nemotron/CAS resolver route and reject deprecated Paddle/CPU/SQS current-route evidence.",
    "- Validation evidence must be signed by the harness before the evaluator can accept completion.", "",
    `IDENTITY NONCE: Include runId="${state.runId}" phaseAttemptId="${state.lock.activePhaseId || ""}" in all harness tool calls.`, "",
    "IMPORTANT: Only the evaluator may declare goal completion.",
    "Even if everything looks perfect, report and let the evaluator judge.",
  ].join("\n");
}

// ── Master render ────────────────────────────────────────────────────

export function renderPhasePrompt(
  phase: (typeof PHASE_ORDER)[number],
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const meta = harnessMeta(state);
  let body: string;
  switch (phase) {
    case "research": body = renderResearchPrompt(state, snapshot, subagentBackend); break;
    case "plan": body = renderPlanPrompt(state, snapshot, subagentBackend); break;
    case "implement": body = renderImplementPrompt(state, snapshot, subagentBackend); break;
    case "validate": body = renderValidatePrompt(state, snapshot, subagentBackend); break;
  }
  return meta + body;
}

// ── Resume ───────────────────────────────────────────────────────────

export function renderResumePrompt(state: IterativeGoalState, snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend): string {
  const phasePrompt = renderPhasePrompt(state.phase, state, snapshot, subagentBackend);
  return [
    "[ITERATIVE-GOAL: RESUMING]", "",
    `Run ID: ${state.runId}`, `Goal: ${state.goal}`, `Criterion: ${state.goalCriterion}`,
    `Status: ${state.status}`, `Cycle: ${state.cycle}`, `Phase: ${state.phase}`,
    `Lock: active=${state.lock.activeRunId ?? "none"} phase=${state.lock.activePhaseId ?? "none"}`,
    "",
    "Rehydration Checklist:",
    `1. Read .pi/iterative-goal/runs/${state.runId}/latest.md`,
    "2. Read events.jsonl for recent events.",
    "3. Check git status, branch, worktrees.",
    `4. Read cycles/${state.cycle}/${state.phase}/result.json`,
    `5. Resume '${state.phase}' phase.`, "",
    `Errors (${state.errors.length}):`,
    ...state.errors.slice(-5).map(e =>
      `  [${e.phase}] ${e.kind}${e.missingTool ? `:${e.missingTool}` : ""} - ${e.recoveryAction}${e.resolved ? " \u2713" : ""}`),
    "",
    "Resume Contract:",
    "- Continue the current phase using the live capability inventory below.",
    "- Use the same runId / phaseAttemptId identity nonce rules as a fresh phase.",
    "- Do NOT declare goal complete.",
    "",
    phasePrompt,
  ].join("\n");
}

// ── Compaction ───────────────────────────────────────────────────────

export function renderCompactionSummary(state: IterativeGoalState): string {
  const taskPlan = state.taskPlan ?? { items: [] };
  const projectInstructions = state.projectInstructions ?? { files: [] };
  return [
    "[ITERATIVE-GOAL COMPACTION SNAPSHOT]",
    `Run ID: ${state.runId}`, `Goal: ${state.goal}`,
    `Status: ${state.status}`, `Cycle: ${state.cycle}`, `Phase: ${state.phase}`,
    `Evaluator: ${state.evaluator.lastVerdict ? `goal_met=${state.evaluator.lastVerdict.goal_met}` : "none"}`,
    `Errors: ${state.errors.length}`,
    `Project Instructions: ${projectInstructions.files.length} files`,
    `Task Plan: ${taskPlan.items.length} items, in_progress=${taskPlan.items.find(item => item.status === "in_progress")?.id ?? "none"}`,
    `Artifacts: R:${state.artifacts.research.length} P:${state.artifacts.plans.length} I:${state.artifacts.implementations.length} V:${state.artifacts.validations.length}`,
    "", `State: .pi/iterative-goal/runs/${state.runId}/`,
    "After compaction, re-read latest.md and resume.",
  ].join("\n");
}

// ── Validation script generator ──────────────────────────────────────

export function generateValidationScript(state: IterativeGoalState, testCommand: string, gateCommand: string): string {
  return generateValidationScriptFromSpecs({
    runId: state.runId,
    cycle: state.cycle,
    checks: verificationSpecsFromLegacyCommands(testCommand, gateCommand),
  });
}
