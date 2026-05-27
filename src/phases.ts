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

function hasTool(ns: CapabilityNamespaces, name: string): boolean {
  return ns.builtinTools.includes(name) || ns.extensionTools.includes(name) || ns.sdkTools.includes(name);
}

function buildToolInstructions(snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend) {
  const ns = buildNamespaces(snapshot);
  const hasGoalShell = hasTool(ns, "goal_shell");
  const hasBash = snapshot.hasBashTool;
  const hasReportResult = hasTool(ns, "goal_report_phase_result");
  const hasRecordBlocker = hasTool(ns, "goal_record_blocker");
  const hasSubagentTool = snapshot.hasSubagentTool || snapshot.hasAgentTool;

  const shellInstruction = hasGoalShell ? "Use goal_shell for shell commands." :
    hasBash ? "Use bash for shell commands." : "No shell tool. Describe commands — harness will execute them.";

  const reportInstruction = hasReportResult
    ? "Call goal_report_phase_result with runId, phaseAttemptId, phase, status, summary, artifacts_produced[], blockers[], recommendations[]."
    : "goal_report_phase_result NOT in tool list. Write findings as final message. Harness synthesizes automatically.";

  const blockerInstruction = hasRecordBlocker
    ? "Record blockers with goal_record_blocker (include runId + phaseAttemptId)."
    : "Describe blockers explicitly in your final message.";

  const subagentInstruction = hasSubagentTool
    ? (hasTool(ns, "goal_subagent") ? "Use goal_subagent for delegation." : `Use ${snapshot.hasSubagentTool ? "subagent" : "Agent"} tool.`)
    : "No subagent backend. Perform ALL work in this session.";

  return { shellInstruction, reportInstruction, blockerInstruction, subagentInstruction };
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
    lastEvalBlock, "", capSummary, "",
    "Research Instructions:",
    "1. Explore the codebase to understand the current state relevant to the goal.",
    "2. Identify files, patterns, tests, and modules that may need changes.",
    "3. Document findings, constraints, and any observed issues.",
    "4. Identify the smallest safe slice of work to begin with.",
    "5. List unresolved questions that need clarification.", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- Subagent: ${ti.subagentInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
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
    "", capSummary, "",
    "Plan Instructions:",
    "1. Read the most recent Research artifact.",
    "2. Propose a bounded implementation plan for THIS cycle only.",
    "3. Include specific files expected to change (exact paths).",
    "4. Include tests or gates that verify correctness.",
    "5. Include safety invariants.",
    "6. Include a fallback path.",
    "7. State assumptions explicitly.", "",
    "Required Plan Sections:",
    "- Exact files to modify (the allowlist)",
    "- Change descriptions per file",
    "- Tests to write/run",
    "- Safety invariants",
    "- Fallback plan",
    "- No-production-write confirmation", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- Subagent: ${ti.subagentInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
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
    capSummary, "",
    "Implementation Instructions:",
    "1. Read the Plan artifact.",
    "2. Execute exactly ONE bounded slice — stay within plan allowlist.",
    "3. Verify repo/worktree state before editing.",
    "4. Use available fallbacks if tools are missing.",
    "5. Record blockers explicitly.",
    "6. Write a detailed summary.", "",
    "CRITICAL RULES:",
    "- Preserve user dirty worktrees.",
    "- Destructive ops need operator approval.",
    "- Do NOT stop if tool is missing; use fallback.",
    "- Do NOT declare goal completion.",
    "- Do NOT edit outside plan allowlist.",
    "- Subagents: 5-minute timeout.",
    `- ${finalizationText}`, "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- Subagent: ${ti.subagentInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
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
    capSummary, "",
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
    "STATUS VOCABULARY:",
    "- PASS / FAIL for gates/tests",
    "- BLOCKED_EXTERNAL for credential/operator blockers",
    "- BLOCKED_HARNESS for safety policy blocks",
    "- NOT_RUN for unattempted items",
    "- Overall: HARNESS_VALIDATED / HARNESS_VALIDATED_EXTERNAL_BLOCKERS / IN_PROGRESS", "",
    "TOOLS THIS CYCLE:",
    `- Shell: ${ti.shellInstruction}`,
    `- Report: ${ti.reportInstruction}`,
    `- Blockers: ${ti.blockerInstruction}`, "",
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
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
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
    "", capSummary, "",
    "Resume the phase. Do NOT declare goal complete.",
  ].join("\n");
}

// ── Compaction ───────────────────────────────────────────────────────

export function renderCompactionSummary(state: IterativeGoalState): string {
  return [
    "[ITERATIVE-GOAL COMPACTION SNAPSHOT]",
    `Run ID: ${state.runId}`, `Goal: ${state.goal}`,
    `Status: ${state.status}`, `Cycle: ${state.cycle}`, `Phase: ${state.phase}`,
    `Evaluator: ${state.evaluator.lastVerdict ? `goal_met=${state.evaluator.lastVerdict.goal_met}` : "none"}`,
    `Errors: ${state.errors.length}`,
    `Artifacts: R:${state.artifacts.research.length} P:${state.artifacts.plans.length} I:${state.artifacts.implementations.length} V:${state.artifacts.validations.length}`,
    "", `State: .pi/iterative-goal/runs/${state.runId}/`,
    "After compaction, re-read latest.md and resume.",
  ].join("\n");
}

// ── Validation script generator ──────────────────────────────────────

export function generateValidationScript(state: IterativeGoalState, testCommand: string, gateCommand: string): string {
  const cycleDir = `.pi/iterative-goal/runs/${state.runId}/cycles/${state.cycle}/validate`;
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    `ARTIFACT_DIR="${cycleDir}"`,
    'mkdir -p "$ARTIFACT_DIR"',
    "",
    `echo "=== VALIDATION RUN ${state.runId} / cycle ${state.cycle} ===" | tee "$ARTIFACT_DIR/validation.log"`,
    'echo "Started at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACT_DIR/validation.log"',
    "",
    "# 1. Repo state",
    'echo "--- Repo State ---" > "$ARTIFACT_DIR/repo-state.txt"',
    "{",
    '  echo "Git status (porcelain):"',
    "  git status --porcelain",
    "  echo",
    '  echo "Full git status:"',
    "  git status",
    "  echo",
    '  echo "Changed files:"',
    "  git diff --name-only",
    "  echo",
    '  echo "Diff stat:"',
    "  git diff --stat",
    "  echo",
    '  echo "Recent log:"',
    "  git log --oneline -5",
    '} >> "$ARTIFACT_DIR/repo-state.txt" 2>&1',
    'echo "Repo state captured."',
    "",
    "# 2. Tests",
    'echo "--- Tests ---" > "$ARTIFACT_DIR/test-results.txt"',
    `TEST_CMD="${testCommand.replace(/"/g, '\\"')}"`,
    'if [ -n "$TEST_CMD" ]; then',
    '  echo "Running: $TEST_CMD"',
    '  set +e',
    '  eval "$TEST_CMD" >> "$ARTIFACT_DIR/test-results.txt" 2>&1',
    "  TEST_EXIT=$?",
    '  set -e',
    '  echo "Exit code: $TEST_EXIT" | tee -a "$ARTIFACT_DIR/test-results.txt"',
    "else",
    '  echo "No test command provided." | tee -a "$ARTIFACT_DIR/test-results.txt"',
    "  TEST_EXIT=0",
    "fi",
    "",
    "# 3. Gates",
    'echo "--- Gates ---" > "$ARTIFACT_DIR/gate-results.txt"',
    `GATE_CMD="${gateCommand.replace(/"/g, '\\"')}"`,
    'if [ -n "$GATE_CMD" ]; then',
    '  echo "Running: $GATE_CMD"',
    "  set +e",
    '  eval "$GATE_CMD" >> "$ARTIFACT_DIR/gate-results.txt" 2>&1 || true',
    "  set -e",
    '  echo "Gate check complete."',
    "else",
    '  echo "No gate command provided."',
    "fi",
    "",
    "# 4. Patch",
    'git diff > "$ARTIFACT_DIR/diff.patch" 2>&1 || true',
    'echo "Patch saved to $ARTIFACT_DIR/diff.patch"',
    "",
    'echo "=== VALIDATION COMPLETE ===" | tee -a "$ARTIFACT_DIR/validation.log"',
    'echo "Finished at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACT_DIR/validation.log"',
    "exit $TEST_EXIT",
  ].join("\n");
}