/**
 * Phase prompt generation.
 *
 * Each phase prompt is authoritative - it includes capability preflight,
 * the current state, evaluator directives, and phase-specific instructions.
 *
 * IMPROVEMENT: Tool instructions are generated from the actual capability
 * snapshot, not hardcoded. The model is never told about unavailable tools.
 */

import {
  type IterativeGoalState,
  type CapabilitySnapshot,
  type CapabilityNamespaces,
  type RunLock,
  PHASE_ORDER,
} from "./types.js";
import type { SubagentBackend } from "./types.js";
import { renderCapabilitySummary, buildNamespaces } from "./capabilities.js";

// ── Tool contract detection ─────────────────────────────────────────

function hasTool(ns: CapabilityNamespaces, name: string): boolean {
  return (
    ns.builtinTools.includes(name) ||
    ns.extensionTools.includes(name) ||
    ns.sdkTools.includes(name)
  );
}

function buildToolInstructions(snapshot: CapabilitySnapshot, subagentBackend: SubagentBackend): {
  shellInstruction: string;
  reportInstruction: string;
  blockerInstruction: string;
  subagentInstruction: string;
} {
  const ns = buildNamespaces(snapshot);

  const hasGoalShell = hasTool(ns, "goal_shell");
  const hasBash = snapshot.hasBashTool;
  const hasReportResult = hasTool(ns, "goal_report_phase_result");
  const hasRecordBlocker = hasTool(ns, "goal_record_blocker");
  const hasSubagentTool = snapshot.hasSubagentTool || snapshot.hasAgentTool;

  // Shell instruction: truthfully say which shell tool to use
  let shellInstruction: string;
  if (hasGoalShell) {
    shellInstruction = "Use goal_shell for shell commands (not bash).";
  } else if (hasBash) {
    shellInstruction = "Use bash for shell commands.";
  } else {
    shellInstruction = "No shell tool is available. Describe commands — the harness will execute them.";
  }

  // Report instruction
  let reportInstruction: string;
  if (hasReportResult) {
    reportInstruction = [
      "When finished, call goal_report_phase_result with your findings.",
      "Parameters: phase, status (completed|failed_recoverable|blocked_by_safety_policy), summary, artifacts_produced[], blockers[], recommendations[].",
    ].join("\n");
  } else {
    reportInstruction = [
      "goal_report_phase_result is NOT in your available tool list.",
      "Write your findings as the final assistant message. The harness will synthesize a phase result automatically.",
    ].join("\n");
  }

  // Blocker instruction
  let blockerInstruction: string;
  if (hasRecordBlocker) {
    blockerInstruction = "Record blockers with goal_record_blocker.";
  } else {
    blockerInstruction = "Describe blockers explicitly in your final message.";
  }

  // Subagent instruction
  let subagentInstruction: string;
  if (hasSubagentTool) {
    if (hasTool(ns, "goal_subagent")) {
      subagentInstruction = "Use goal_subagent for delegation (handles backend detection automatically).";
    } else {
      subagentInstruction = `Use ${snapshot.hasSubagentTool ? "subagent" : "Agent"} tool for delegation.`;
    }
  } else if (hasTool(ns, "goal_subagent")) {
    subagentInstruction = "Use goal_subagent for delegation. Backend will fall back to single-agent scouting.";
  } else {
    subagentInstruction = "No subagent backend available. Perform ALL work in this session.";
  }

  return { shellInstruction, reportInstruction, blockerInstruction, subagentInstruction };
}

// ── Harness meta header ──────────────────────────────────────────────

function harnessMeta(state: IterativeGoalState): string {
  const v = state.evaluator.lastVerdict;
  return [
    `[HARNESS_META] runId=${state.runId} cycle=${state.cycle} phase=${state.phase} status=${state.status}${v ? ` lastVerdict=${v.goal_met}/${v.confidence}` : ""}`,
    ``,
  ].join("\n");
}

// ── Research phase ──────────────────────────────────────────────────

export function renderResearchPrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const instructions = buildToolInstructions(snapshot, subagentBackend);

  let lastEvalBlock = "";
  if (state.evaluator.lastVerdict) {
    const v = state.evaluator.lastVerdict;
    lastEvalBlock = [
      `Evaluator says goal_met=false because:`,
      ...v.remaining_work.map(
        (w, i) => `  ${i + 1}. [${w.priority}] ${w.description}`,
      ),
      v.next_cycle_directive.focus === "capability_repair"
        ? `  Next cycle directive: ${v.next_cycle_directive.focus} - ${v.next_cycle_directive.reason}`
        : `  Next cycle focus: ${v.next_cycle_directive.focus}`,
    ].join("\n");
  } else {
    lastEvalBlock = "No prior evaluator verdict. This is the first cycle.";
  }

  return [
    `[ITERATIVE-GOAL PHASE 1/4: RESEARCH]`,
    ``,
    `Run ID: ${state.runId}`,
    `Cycle: ${state.cycle}`,
    ``,
    `Goal:`,
    `${state.goal}`,
    ``,
    `Completion Criterion:`,
    `${state.goalCriterion}`,
    ``,
    lastEvalBlock,
    ``,
    capSummary,
    ``,
    `Research Instructions:`,
    `1. Explore the codebase to understand the current state relevant to the goal.`,
    `2. Identify files, patterns, tests, and modules that may need changes.`,
    `3. Document findings, constraints, and any observed issues.`,
    `4. Identify the smallest safe slice of work to begin with.`,
    `5. List unresolved questions that need clarification.`,
    ``,
    `TOOLS THIS CYCLE:`,
    `- Shell: ${instructions.shellInstruction}`,
    `- Subagent: ${instructions.subagentInstruction}`,
    `- Report: ${instructions.reportInstruction}`,
    `- Blockers: ${instructions.blockerInstruction}`,
    ``,
    `IMPORTANT:`,
    `- Do NOT make any file edits during Research.`,
    `- Do NOT call MCP servers not listed in the capability inventory.`,
    `- Do NOT stop or declare completion. Completion is evaluator-only.`,
    `- Do NOT invent tools not listed in the capability preflight.`,
  ].join("\n");
}

// ── Plan phase ──────────────────────────────────────────────────────

export function renderPlanPrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const instructions = buildToolInstructions(snapshot, subagentBackend);

  return [
    `[ITERATIVE-GOAL PHASE 2/4: PLAN]`,
    ``,
    `Run ID: ${state.runId}`,
    `Cycle: ${state.cycle}`,
    ``,
    `Goal:`,
    `${state.goal}`,
    ``,
    `Previous Artifacts:`,
    `- Research cycles: ${state.artifacts.research.length}`,
    `- Plans: ${state.artifacts.plans.length}`,
    `- Implementations: ${state.artifacts.implementations.length}`,
    `- Validations: ${state.artifacts.validations.length}`,
    ``,
    `Evaluator Feedback:`,
    state.evaluator.lastVerdict
      ? [
          `goal_met=${state.evaluator.lastVerdict.goal_met}`,
          `confidence=${state.evaluator.lastVerdict.confidence}`,
          ...state.evaluator.lastVerdict.remaining_work.map(
            (w) => `  [${w.priority}] ${w.description}`,
          ),
        ].join("\n")
      : "No evaluator feedback yet.",
    ``,
    capSummary,
    ``,
    `Plan Instructions:`,
    `1. Read the most recent Research artifact to understand what's been found.`,
    `2. Propose a bounded implementation plan for THIS cycle only.`,
    `3. Include specific files expected to change (exact paths).`,
    `4. Include tests or gates that verify correctness.`,
    `5. Include safety invariants that must not be violated.`,
    `6. Include a fallback path if the implementation fails.`,
    `7. State assumptions explicitly.`,
    ``,
    `Required Plan Sections:`,
    `- Exact files to modify (the "allowlist")`,
    `- Change descriptions per file`,
    `- Tests to write/run`,
    `- Safety invariants to preserve`,
    `- Fallback plan if blocked`,
    `- No-production-write confirmation`,
    ``,
    `TOOLS THIS CYCLE:`,
    `- Shell: ${instructions.shellInstruction}`,
    `- Subagent: ${instructions.subagentInstruction}`,
    `- Report: ${instructions.reportInstruction}`,
    `- Blockers: ${instructions.blockerInstruction}`,
    ``,
    `If information is missing, state assumptions and choose the safest non-destructive next step.`,
    `Do NOT stop. Report your plan as the final message.`,
  ].join("\n");
}

// ── Implement phase ─────────────────────────────────────────────────

export function renderImplementPrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const instructions = buildToolInstructions(snapshot, subagentBackend);

  // Finalization policy text
  const fp = state.finalizationPolicy;
  const finalizationText = fp.allowGitFinalization
    ? "Git finalization is ENABLED. You may commit changes."
    : "Git finalization is DISABLED. DO NOT attempt git add/commit/push. The harness will produce a patch instead.";

  return [
    `[ITERATIVE-GOAL PHASE 3/4: IMPLEMENT]`,
    ``,
    `Run ID: ${state.runId}`,
    `Cycle: ${state.cycle}`,
    ``,
    `Goal:`,
    `${state.goal}`,
    ``,
    capSummary,
    ``,
    `Implementation Instructions:`,
    `1. Read the Plan artifact from this cycle.`,
    `2. Execute exactly ONE bounded slice of work — stay within the plan's file allowlist.`,
    `3. Before editing, verify repo/worktree state is clean.`,
    `4. If a required tool is unavailable, use available fallbacks.`,
    `5. Record any blockers or issues explicitly.`,
    `6. After implementation, write a detailed summary.`,
    ``,
    `CRITICAL RULES:`,
    `- Preserve user dirty worktrees. Do not force-clean.`,
    `- If destructive operations are needed, they require operator approval.`,
    `- Do NOT stop if a tool is missing; use fallback or record blocker.`,
    `- Do NOT declare goal completion. The evaluator decides.`,
    `- Do NOT edit files outside the plan's allowlist.`,
    `- Subagents must return within 5 minutes or be considered failed.`,
    `- ${finalizationText}`,
    ``,
    `TOOLS THIS CYCLE:`,
    `- Shell: ${instructions.shellInstruction}`,
    `- Subagent: ${instructions.subagentInstruction}`,
    `- Report: ${instructions.reportInstruction}`,
    `- Blockers: ${instructions.blockerInstruction}`,
    ``,
    `Write your implementation summary as the final message. The harness will collect changed file info and validate against the plan.`,
  ].join("\n");
}

// ── Validate phase ──────────────────────────────────────────────────

export function renderValidatePrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);
  const instructions = buildToolInstructions(snapshot, subagentBackend);

  const cycleDir = `.pi/iterative-goal/runs/${state.runId}/cycles/${state.cycle}/validate`;

  // Generate validation script (harness-owned, not model-written)
  const validationScript = [
    `#!/usr/bin/env bash`,
    `set -euo pipefail`,
    `ARTIFACT_DIR="${cycleDir}"`,
    `mkdir -p "$ARTIFACT_DIR"`,
    `{`,
    `  git status --porcelain`,
    `  echo`,
    `  echo "=== FULL GIT STATUS ==="`,
    `  git status`,
    `  echo`,
    `  echo "=== GIT DIFF STAT ==="`,
    `  git diff --stat`,
    `  echo`,
    `  echo "=== CHANGED FILES ==="`,
    `  git diff --name-only`,
    `  echo`,
    `  echo "=== RECENT LOG ==="`,
    `  git log --oneline -5`,
    `} > "$ARTIFACT_DIR/repo-state.txt" 2>&1`,
  ].join("\n");

  return [
    `[ITERATIVE-GOAL PHASE 4/4: VALIDATE]`,
    ``,
    `Run ID: ${state.runId}`,
    `Cycle: ${state.cycle}`,
    ``,
    `Goal:`,
    `${state.goal}`,
    ``,
    `Completion Criterion:`,
    `${state.goalCriterion}`,
    ``,
    capSummary,
    ``,
    `Validation Instructions:`,
    `1. Collect validation evidence and PERSIST IT TO FILES in: ${cycleDir}/`,
    `2. Run tests and capture output to ${cycleDir}/test-results.txt`,
    `3. Run gate checks and capture to ${cycleDir}/gate-results.txt`,
    `4. Capture repo state to ${cycleDir}/repo-state.txt`,
    ``,
    `Harness-generated validation script:`,
    `\`\`\`bash`,
    validationScript,
    `\`\`\``,
    ``,
    `Run this script via your shell tool, then run your specific test/gate commands.`,
    `Append test output: YOUR_TEST_COMMAND >> ${cycleDir}/test-results.txt 2>&1`,
    ``,
    `STATUS VOCABULARY (use these exact terms in reports):`,
    `- PASS / FAIL — for individual gates and tests`,
    `- BLOCKED_EXTERNAL — items requiring credentials, operator action`,
    `- BLOCKED_HARNESS — items blocked by harness safety policy`,
    `- NOT_RUN — items not yet attempted`,
    ``,
    `For overall status: HARNESS_VALIDATED / HARNESS_VALIDATED_EXTERNAL_BLOCKERS / IN_PROGRESS`,
    `Do NOT use "Final" or "complete" unless evaluator has accepted.`,
    ``,
    `TOOLS THIS CYCLE:`,
    `- Shell: ${instructions.shellInstruction}`,
    `- Report: ${instructions.reportInstruction}`,
    `- Blockers: ${instructions.blockerInstruction}`,
    ``,
    `IMPORTANT: The evaluator is the ONLY entity that can declare the goal complete.`,
    `Even if everything looks perfect, report and let the evaluator judge.`,
  ].join("\n");
}

// ── Master render function ──────────────────────────────────────────

export function renderPhasePrompt(
  phase: (typeof PHASE_ORDER)[number],
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const meta = harnessMeta(state);

  let body: string;
  switch (phase) {
    case "research":
      body = renderResearchPrompt(state, snapshot, subagentBackend);
      break;
    case "plan":
      body = renderPlanPrompt(state, snapshot, subagentBackend);
      break;
    case "implement":
      body = renderImplementPrompt(state, snapshot, subagentBackend);
      break;
    case "validate":
      body = renderValidatePrompt(state, snapshot, subagentBackend);
      break;
  }
  return meta + body;
}

// ── Resume prompt (after compaction or session reload) ──────────────

export function renderResumePrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);

  return [
    `[ITERATIVE-GOAL: RESUMING AUTONOMOUS LOOP]`,
    ``,
    `You are resuming a previously running iterative-goal loop.`,
    ``,
    `Run ID: ${state.runId}`,
    `Goal: ${state.goal}`,
    `Criterion: ${state.goalCriterion}`,
    `Status: ${state.status}`,
    `Cycle: ${state.cycle}`,
    `Current Phase: ${state.phase}`,
    `Lock: active=${state.lock.activeRunId ?? "none"} phase=${state.lock.activePhaseId ?? "none"}`,
    ``,
    `Rehydration Checklist:`,
    `1. Read .pi/iterative-goal/runs/${state.runId}/latest.md for the full state summary.`,
    `2. Read the last few lines of events.jsonl for recent events.`,
    `3. Inspect current repo state (git status, branch, active worktrees).`,
    `4. Read the most recent result.json for phase '${state.phase}' in cycles/${state.cycle}.`,
    `5. Resume the '${state.phase}' phase from where it was interrupted.`,
    ``,
    `Recorded errors (${state.errors.length}):`,
    ...state.errors.slice(-5).map(
      (e) =>
        `  [${e.phase}] ${e.kind}${e.missingTool ? `:${e.missingTool}` : ""} - ${e.recoveryAction}${e.resolved ? " ✓" : ""}`,
    ),
    ``,
    capSummary,
    ``,
    `Resume the '${state.phase}' phase. Do NOT declare the goal complete — only the evaluator can.`,
  ].join("\n");
}

// ── Compaction recovery summary ─────────────────────────────────────

export function renderCompactionSummary(state: IterativeGoalState): string {
  return [
    `[ITERATIVE-GOAL COMPACTION SNAPSHOT]`,
    `Run ID: ${state.runId}`,
    `Goal: ${state.goal}`,
    `Status: ${state.status}`,
    `Cycle: ${state.cycle}`,
    `Phase: ${state.phase}`,
    `Evaluator verdict: ${state.evaluator.lastVerdict ? `goal_met=${state.evaluator.lastVerdict.goal_met}` : "none"}`,
    `Errors: ${state.errors.length}`,
    `Artifacts: R:${state.artifacts.research.length} P:${state.artifacts.plans.length} I:${state.artifacts.implementations.length} V:${state.artifacts.validations.length}`,
    ``,
    `Run-scoped state files:`,
    `  .pi/iterative-goal/runs/${state.runId}/`,
    `  .pi/iterative-goal/active-run.json`,
    ``,
    `After compaction, re-read latest.md and resume phase '${state.phase}'.`,
  ].join("\n");
}

// ── Validation script generator ─────────────────────────────────────

export function generateValidationScript(
  state: IterativeGoalState,
  testCommand: string,
  gateCommand: string,
): string {
  const cycleDir = `.pi/iterative-goal/runs/${state.runId}/cycles/${state.cycle}/validate`;

  return [
    `#!/usr/bin/env bash`,
    `set -euo pipefail`,
    `ARTIFACT_DIR="${cycleDir}"`,
    `mkdir -p "$ARTIFACT_DIR"`,
    ``,
    `echo "=== VALIDATION RUN ${state.runId} / cycle ${state.cycle} ===" | tee "$ARTIFACT_DIR/validation.log"`,
    `echo "Started at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACT_DIR/validation.log"`,
    ``,
    `# 1. Repo state`,
    `echo "--- Repo State ---" > "$ARTIFACT_DIR/repo-state.txt"`,
    `{`,
    `  echo "Git status (porcelain):"`,
    `  git status --porcelain`,
    `  echo`,
    `  echo "Full git status:"`,
    `  git status`,
    `  echo`,
    `  echo "Changed files:"`,
    `  git diff --name-only`,
    `  echo`,
    `  echo "Diff stat:"`,
    `  git diff --stat`,
    `  echo`,
    `  echo "Recent log:"`,
    `  git log --oneline -5`,
    `} >> "$ARTIFACT_DIR/repo-state.txt" 2>&1`,
    `echo "Repo state captured."`,
    ``,
    `# 2. Test command`,
    `echo "--- Tests ---" > "$ARTIFACT_DIR/test-results.txt"`,
    `if [ -n "${testCommand}" ]; then`,
    `  echo "Running: ${testCommand}"`,
    `  eval "${testCommand}" >> "$ARTIFACT_DIR/test-results.txt" 2>&1`,
    `  TEST_EXIT=$?`,
    `  echo "Test exit code: $TEST_EXIT" | tee -a "$ARTIFACT_DIR/test-results.txt"`,
    `else`,
    `  echo "No test command provided." | tee -a "$ARTIFACT_DIR/test-results.txt"`,
    `  TEST_EXIT=0`,
    `fi`,
    ``,
    `# 3. Gate command`,
    `echo "--- Gates ---" > "$ARTIFACT_DIR/gate-results.txt"`,
    `if [ -n "${gateCommand}" ]; then`,
    `  echo "Running: ${gateCommand}"`,
    `  eval "${gateCommand}" >> "$ARTIFACT_DIR/gate-results.txt" 2>&1 || true`,
    `  echo "Gate check completed."`,
    `else`,
    `  echo "No gate command provided."`,
    `fi`,
    ``,
    `# 4. Generate patch`,
    `git diff > "$ARTIFACT_DIR/diff.patch" 2>&1 || true`,
    `echo "Patch saved to $ARTIFACT_DIR/diff.patch"`,
    ``,
    `echo "=== VALIDATION COMPLETE ===" | tee -a "$ARTIFACT_DIR/validation.log"`,
    `echo "Finished at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACT_DIR/validation.log"`,
    `exit $TEST_EXIT`,
  ].join("\n");
}