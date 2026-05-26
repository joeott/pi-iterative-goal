/**
 * Phase prompt generation.
 *
 * Each phase prompt is authoritative - it includes capability preflight,
 * the current state, evaluator directives, and phase-specific instructions.
 */

import { type IterativeGoalState, type CapabilitySnapshot, PHASE_ORDER } from "./types.js";
import type { SubagentBackend } from "./types.js";
import { renderCapabilitySummary } from "./capabilities.js";

// ── Research phase ──────────────────────────────────────────────────

export function renderResearchPrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);

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
    `IMPORTANT:`,
    `- Do NOT make any file edits during Research.`,
    `- If you need to run shell commands, use goal_shell (not bash).`,
    `- If subagent is unavailable, perform single-agent scouting.`,
    `- Do NOT call MCP servers not listed in the capability inventory.`,
    `- Do NOT stop or declare completion. Completion is evaluator-only.`,
    ``,
    `When finished, call goal_report_phase_result with phase="research" and your findings.`,
    `If goal_report_phase_result is not in your available tool list, write your findings as the final assistant message. The harness will synthesize it automatically.`,
  ].join("\n");
}

// ── Plan phase ──────────────────────────────────────────────────────

export function renderPlanPrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);

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
            (w) =>
              `  [${w.priority}] ${w.description}`,
          ),
        ].join("\n")
      : "No evaluator feedback yet.",
    ``,
    capSummary,
    ``,
    `Plan Instructions:`,
    `1. Read the most recent Research artifact to understand what's been found.`,
    `2. Propose a bounded implementation plan for THIS cycle only.`,
    `3. Include specific files expected to change.`,
    `4. Include tests or gates that verify correctness.`,
    `5. Include safety invariants that must not be violated.`,
    `6. Include a fallback path if the implementation fails.`,
    `7. State assumptions explicitly.`,
    ``,
    `Required Plan Sections:`,
    `- Exact files to modify`,
    `- Change descriptions per file`,
    `- Tests to write/run`,
    `- Safety invariants to preserve`,
    `- Fallback plan if blocked`,
    `- No-production-write confirmation`,
    ``,
    `If information is missing, state assumptions and choose the safest non-destructive next step.`,
    `Do NOT stop. Call goal_report_phase_result when done.`,
    `If goal_report_phase_result is not in your available tool list, write your plan as the final assistant message. The harness will synthesize it automatically.`,
  ].join("\n");
}

// ── Implement phase ─────────────────────────────────────────────────

export function renderImplementPrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);

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
    `2. Execute exactly ONE bounded slice of work.`,
    `3. Before editing, verify repo/worktree state is clean.`,
    `4. If a required tool is unavailable, use extension fallback (goal_shell, etc.).`,
    `5. Record any blockers or issues with goal_record_blocker.`,
    `6. After implementation, call goal_report_phase_result.`,
    ``,
    `CRITICAL RULES:`,
    `- Preserve user dirty worktrees. Do not force-clean.`,
    `- If destructive operations are needed, they require operator approval.`,
    `- Do NOT stop if a tool is missing; use fallback or record blocker.`,
    `- Do NOT declare goal completion. The evaluator decides.`,
    `- Do NOT delegate to subagents for operations known to be harness-blocked (e.g., git writes).`,
    `- Subagents must return within 5 minutes or be considered failed. Fall back to single-agent work.`,
    ``,
    `If goal_report_phase_result is not in your available tool list, write your implementation summary as the final assistant message. The harness will synthesize it automatically.`,
  ].join("\n");
}

// ── Validate phase ──────────────────────────────────────────────────

export function renderValidatePrompt(
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const capSummary = renderCapabilitySummary(snapshot, subagentBackend);

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
    `1. Collect validation evidence and PERSIST IT TO FILES:`,
    `   a. Run tests and capture full output:`,
    `      goal_shell command="<test command> 2>&1 | tee .pi/iterative-goal/test-results-cycle-${state.cycle}.txt"`,
    `   b. Run gate checks and capture output:`,
    `      goal_shell command="<gate command> 2>&1 | tee .pi/iterative-goal/gate-results-cycle-${state.cycle}.txt"`,
    `   c. Capture repo state:`,
    `      goal_shell command="git status && git log --oneline -5 > .pi/iterative-goal/repo-state-cycle-${state.cycle}.txt"`,
    `2. Create a validation summary in your phase result with structured counts (tests passed/failed, gates passed/failed).`,
    `3. List any known failures or blockers, distinguishing EXTERNAL vs HARNESS blockers.`,
    `4. Do NOT self-certify goal completion.`,
    `5. Call goal_report_phase_result with your validation summary.`,
    `6. If git commit operations are blocked, generate a patch file instead:`,
    `   goal_shell command="git diff > .pi/iterative-goal/final-cycle-${state.cycle}.patch"`,
    ``,
    `STATUS VOCABULARY (use these exact terms in reports):`,
    `- PASS / FAIL — for individual gates and tests`,
    `- BLOCKED_EXTERNAL — items requiring credentials, operator action, or permissions outside the harness`,
    `- BLOCKED_HARNESS — items blocked by harness safety policy (e.g., git writes)`,
    `- NOT_RUN — items not yet attempted`,
    `For overall status use one of:`,
    `- HARNESS_VALIDATED — all in-harness work passes, no blockers`,
    `- HARNESS_VALIDATED_EXTERNAL_BLOCKERS — all in-harness work passes, external blockers remain`,
    `- IN_PROGRESS — implementation or validation still needed`,
    `Do NOT use "Final", "complete", or "all waves complete" unless the evaluator has accepted the goal.`,
    ``,
    `IMPORTANT:`,
    `- The evaluator is the ONLY entity that can declare the goal complete.`,
    `- Even if everything looks perfect, you must report and let the evaluator judge.`,
    `- Include both positive evidence and remaining issues.`,
    ``,
    `If goal_report_phase_result is not in your available tool list, write your validation summary as the final assistant message. The harness will synthesize it automatically.`,
  ].join("\n");
}

// ── Master render function ──────────────────────────────────────────

export function renderPhasePrompt(
  phase: (typeof PHASE_ORDER)[number],
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const verdict = state.evaluator.lastVerdict;
  const meta = `[HARNESS_META] runId=${state.runId} cycle=${state.cycle} phase=${phase} status=${state.status}${verdict ? ` lastVerdict=${verdict.goal_met}/${verdict.confidence}` : ""}\n\n`;

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
    ``,
    `Rehydration Checklist:`,
    `1. Read .pi/iterative-goal/latest.md for the full state summary.`,
    `2. Read the last few lines of .pi/iterative-goal/events.jsonl for recent events.`,
    `3. Inspect current repo state (git status, branch, active worktrees).`,
    `4. Read the most recent artifact for phase '${state.phase}' from cycle ${state.cycle}.`,
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
    `Resume the '${state.phase}' phase. Do NOT declare the goal complete - only the evaluator can.`,
  ].join("\n");
}

// ── Compaction recovery summary ─────────────────────────────────────

export function renderCompactionSummary(state: IterativeGoalState): string {
  const lines = [
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
    `Persistent state files:`,
    `  .pi/iterative-goal/state.json`,
    `  .pi/iterative-goal/events.jsonl`,
    `  .pi/iterative-goal/latest.md`,
    `  .pi/iterative-goal/evaluator-verdicts.jsonl`,
    ``,
    `After compaction, re-read latest.md and resume phase '${state.phase}'.`,
  ];

  return lines.join("\n");
}