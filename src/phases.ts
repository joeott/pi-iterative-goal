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
    `1. Collect validation evidence for the implementation in this cycle:`,
    `   - Run focused tests`,
    `   - Run broad gates if available`,
    `   - Check repo lock status`,
    `   - Check PR/CI status if applicable`,
    `   - Verify safety invariants`,
    `2. List any known failures or blockers.`,
    `3. Do NOT self-certify goal completion.`,
    `4. Call goal_report_phase_result with your validation summary.`,
    `5. The external evaluator will review and decide.`,
    ``,
    `IMPORTANT:`,
    `- The evaluator is the ONLY entity that can declare the goal complete.`,
    `- Even if everything looks perfect, you must report and let the evaluator judge.`,
    `- Include both positive evidence and remaining issues.`,
  ].join("\n");
}

// ── Master render function ──────────────────────────────────────────

export function renderPhasePrompt(
  phase: (typeof PHASE_ORDER)[number],
  state: IterativeGoalState,
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  switch (phase) {
    case "research":
      return renderResearchPrompt(state, snapshot, subagentBackend);
    case "plan":
      return renderPlanPrompt(state, snapshot, subagentBackend);
    case "implement":
      return renderImplementPrompt(state, snapshot, subagentBackend);
    case "validate":
      return renderValidatePrompt(state, snapshot, subagentBackend);
  }
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