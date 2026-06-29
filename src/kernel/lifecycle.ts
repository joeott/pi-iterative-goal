import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectSubagentBackend } from "../capabilities.js";
import { updateStatusBar, updateWidget } from "../dashboard.js";
import { createErrorRecord } from "../errors.js";
import { runExternalEvaluator } from "../evaluator.js";
import {
  renderCompactionSummary,
  renderPhasePrompt,
  renderResumePrompt,
} from "../phases.js";
import { type StateManagerAPI, nextPhase as stateNextPhase } from "../state.js";
import {
  type CapabilitySnapshot,
  type IterativeGoalState,
  type Phase,
  type PhaseArtifact,
} from "../types.js";
import { verifyImplementationAgainstPlan } from "../workspace/change-set.js";
import { synthesizePhaseResultSafe } from "./output-synthesis.js";
import { startPhaseAttempt } from "./workflow-engine.js";

export interface LifecycleServices {
  buildRuntimeCapabilitySnapshot(
    ctx: ExtensionContext,
    state: IterativeGoalState,
  ): Promise<CapabilitySnapshot>;
  log(message: string): void;
}

export function registerGoalLifecycle(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
  services: LifecycleServices,
): void {
  pi.on("agent_end", async (event, ctx) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    services.log(`agent_end: runId=${state.runId} cycle=${state.cycle} phase=${state.phase}`);

    if (state.lock.activeRunId !== state.runId) {
      services.log("agent_end: run does not own lock — skipping");
      return;
    }

    const phaseAttemptId = state.lock.activePhaseId || "";
    if (!phaseAttemptId) {
      services.log("agent_end: no active phaseAttemptId — skipping synthesis");
      return;
    }

    stateManager.recordPhaseEvent({
      runId: state.runId, cycle: state.cycle, phase: state.phase,
      phaseAttemptId, attempt: state.phaseAttempts.filter(
        a => a.cycle === state.cycle && a.phase === state.phase,
      ).length + 1,
      kind: "phase_output_received", timestamp: new Date().toISOString(),
    });

    const lastArtifact = getLastArtifactForPhaseCycle(state, state.phase, state.cycle);
    if (!lastArtifact) {
      const synthesized = synthesizePhaseResultSafe(event, state.phase, state.cycle, state.runId, phaseAttemptId);
      if (synthesized) {
        stateManager.recordArtifact(synthesized);
        stateManager.recordPhaseEvent({
          runId: state.runId, cycle: state.cycle, phase: state.phase,
          phaseAttemptId, attempt: state.phaseAttempts.filter(
            a => a.cycle === state.cycle && a.phase === state.phase,
          ).length + 1,
          kind: "phase_result_parsed", timestamp: new Date().toISOString(),
          details: { synthesized: true, nonceMatch: synthesized._nonceMatched ?? false },
        });
        services.log(`Synthesized ${state.phase} result`);
      }
    }

    const artifactForTransition = getLastArtifactForPhaseCycle(state, state.phase, state.cycle);
    const phaseAttemptCount = state.phaseAttempts.filter(
      a => a.cycle === state.cycle && a.phase === state.phase,
    ).length;
    const shouldRetrySamePhase = state.phase !== "validate"
      && isSyntheticCaptureFailure(artifactForTransition)
      && phaseAttemptCount < 2;

    if (shouldRetrySamePhase) {
      stateManager.completePhaseAttempt(phaseAttemptId, "failed");
      stateManager.recordError(createErrorRecord(
        `No output detected from model during ${state.phase} phase. Synthetic parser fallback fired despite agent_end payload.`,
        state.phase,
        state.cycle,
      ));
      state.lock.phaseStatus = "paused";
      stateManager.persistAll();

      const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);
      await startPhaseAttempt(state, stateManager, state.phase, snapshot, pi, ctx);
      const prompt = renderPhasePrompt(state.phase, state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      services.log(`Retrying ${state.phase} after synthetic capture failure`);
      return;
    }

    if (state.phase !== "validate" && isSyntheticCaptureFailure(artifactForTransition)) {
      stateManager.completePhaseAttempt(phaseAttemptId, "failed");
      stateManager.recordError(createErrorRecord(
        `Synthetic capture failure persisted after retry in ${state.phase} phase. Awaiting manual resume or capability repair.`,
        state.phase,
        state.cycle,
      ));
      state.lock.phaseStatus = "paused";
      stateManager.persistAll();
      updateStatusBar(ctx, state);
      updateWidget(ctx, state);
      ctx.ui.notify(`Iterative goal paused in ${state.phase}: synthetic output capture failure persisted after retry.`, "warning");
      services.log(`Pausing ${state.phase} after repeated synthetic capture failure`);
      return;
    }

    stateManager.completePhaseAttempt(phaseAttemptId, "completed");

    if (state.phase === "implement") {
      const diffInfo = await verifyImplementationAgainstPlan(state, stateManager);
      services.log(`Implement verify: ${diffInfo.changedFiles.length} changed, ${diffInfo.plannedFiles.length} planned, violation=${diffInfo.allowlistViolation}`);
      stateManager.recordPhaseEvent({
        runId: state.runId, cycle: state.cycle, phase: state.phase,
        phaseAttemptId, attempt: state.phaseAttempts.length,
        kind: "phase_artifacts_persisted", timestamp: new Date().toISOString(),
        details: {
          changedFiles: diffInfo.changedFiles,
          plannedFiles: diffInfo.plannedFiles,
          allowlistViolation: diffInfo.allowlistViolation,
        },
      });
    }

    stateManager.recordPhaseEvent({
      runId: state.runId, cycle: state.cycle, phase: state.phase,
      phaseAttemptId, attempt: state.phaseAttempts.length,
      kind: "phase_result_committed", timestamp: new Date().toISOString(),
    });
    stateManager.persistAll();

    if (state.phase === "validate") {
      await handleValidateTransition(pi, ctx, stateManager, services, state, phaseAttemptId);
      return;
    }

    await advanceToNextPhase(pi, ctx, stateManager, services, state, phaseAttemptId);
  });

  pi.on("session_start", async (_event, ctx) => {
    services.log(`session_start: reason=${(_event as any).reason}`);

    const restored = stateManager.restore(ctx);
    if (restored) {
      services.log(`Restored: runId=${restored.runId}, cycle=${restored.cycle}, status=${restored.status}`);

      updateStatusBar(ctx, restored);
      updateWidget(ctx, restored);

      if (restored.status === "running") {
        ctx.ui.notify(`Resuming iterative goal: cycle ${restored.cycle}, phase ${restored.phase}`, "info");

        const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, restored);
        stateManager.setCapabilities(snapshot);
        const backends = detectSubagentBackend(pi, snapshot);

        await startPhaseAttempt(restored, stateManager, restored.phase, snapshot, pi, ctx);

        const prompt = renderResumePrompt(restored, snapshot, backends);
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    }
  });

  pi.on("session_shutdown", async () => {
    const state = stateManager.getState();
    if (state) {
      state.lock.phaseStatus = "paused";
      stateManager.persistAll();
      services.log("Shutdown: state persisted with paused lock");
    }
  });

  pi.on("session_before_compact", async (event) => {
    const state = stateManager.getState();
    if (!state) return;
    const summary = renderCompactionSummary(state);
    stateManager.persistAll();
    return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
}

async function handleValidateTransition(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stateManager: StateManagerAPI,
  services: LifecycleServices,
  state: IterativeGoalState,
  phaseAttemptId: string,
): Promise<void> {
  services.log(`Running external evaluator for cycle ${state.cycle}`);

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase: state.phase,
    phaseAttemptId, attempt: state.phaseAttempts.length,
    kind: "evaluator_queued", timestamp: new Date().toISOString(),
  });

  const verdict = await runExternalEvaluator(pi, state, ctx, stateManager);
  stateManager.recordVerdict(verdict);

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase: state.phase,
    phaseAttemptId, attempt: state.phaseAttempts.length,
    kind: "evaluator_verdict_recorded", timestamp: new Date().toISOString(),
    details: { goal_met: verdict.goal_met, confidence: verdict.confidence },
  });

  updateStatusBar(ctx, state);
  updateWidget(ctx, state);

  if (verdict.goal_met === true) {
    stateManager.markSucceeded();
    stateManager.releaseLock(state.runId, phaseAttemptId);
    updateStatusBar(ctx, state);
    updateWidget(ctx, state);
    pi.sendMessage({
      customType: "iterative-goal-complete",
      content: [
        "## Goal Complete \u2713", "",
        `**Goal**: ${state.goal}`, `**Cycles**: ${state.cycle}`,
        `**Evaluator confidence**: ${verdict.confidence}`, "",
        verdict.accepted_evidence.length > 0
          ? `**Accepted evidence**:\n${verdict.accepted_evidence.map(e => `- ${e}`).join("\n")}` : "",
      ].join("\n"),
      display: true,
    }, { triggerTurn: false });
    ctx.ui.notify("Iterative goal completed by external evaluator.");
    services.log(`GOAL MET after ${state.cycle} cycles`);
    return;
  }

  if (verdict.next_cycle_directive.focus === "external_blocked_complete") {
    stateManager.markCompletedBlocked();
    stateManager.releaseLock(state.runId, phaseAttemptId);
    updateStatusBar(ctx, state);
    updateWidget(ctx, state);

    const patchPath = stateManager.getArtifactPath(state.cycle, "validate", "final.patch");
    try {
      const { execSync } = await import("node:child_process");
      const fs = await import("node:fs");
      fs.writeFileSync(patchPath, execSync("git diff", { encoding: "utf-8", timeout: 10_000 }));
    } catch {}

    pi.sendMessage({
      customType: "iterative-goal-completed-blocked",
      content: [
        "## Harness Work Complete — External Blockers Remain", "",
        `**Goal**: ${state.goal}`, `**Cycles**: ${state.cycle}`,
        `**Evaluator confidence**: ${verdict.confidence}`, "",
        "**External Blockers**:", ...verdict.completion_blockers.map(b => `- ${b}`), "",
        "**Accepted Evidence**:", ...verdict.accepted_evidence.map(e => `- ${e}`), "",
        `All in-harness work is complete.`, `Patch: ${patchPath}`, `Resolve external blockers manually.`,
      ].join("\n"),
      display: true,
    }, { triggerTurn: false });
    ctx.ui.notify("Iterative goal: harness work complete. External blockers remain.");
    services.log(`COMPLETED_EXTERNAL_BLOCKERS after ${state.cycle} cycles`);
    return;
  }

  if (verdict.next_cycle_directive.focus === "pending_approval") {
    stateManager.setStatus("pending_approval");
    state.lock.phaseStatus = "paused";
    stateManager.releaseLock(state.runId, phaseAttemptId);
    updateStatusBar(ctx, state);
    updateWidget(ctx, state);
    ctx.ui.notify("Iterative goal suspended pending operator approval.", "warning");
    services.log(`PENDING_APPROVAL after cycle ${state.cycle}`);
    return;
  }

  state.lock.phaseStatus = "transition_pending";
  stateManager.incrementCycle();
  stateManager.setPhase("research");
  stateManager.persistAll();

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase: "research",
    phaseAttemptId, attempt: 1,
    kind: "transition_decided", timestamp: new Date().toISOString(),
    details: { from: "validate", reason: "goal_met=false" },
  });

  updateStatusBar(ctx, state);
  updateWidget(ctx, state);

  const nextPhase: Phase =
    verdict.next_cycle_directive.focus === "capability_repair" ? "research"
      : (verdict.next_cycle_directive.focus as Phase);

  stateManager.setPhase(nextPhase);
  const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
  stateManager.setCapabilities(snapshot);
  const backends = detectSubagentBackend(pi, snapshot);

  await startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi, ctx);

  const prompt = renderPhasePrompt(nextPhase, state, snapshot, backends);
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  services.log(`Next cycle ${state.cycle} starting with ${nextPhase}`);
}

async function advanceToNextPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stateManager: StateManagerAPI,
  services: LifecycleServices,
  state: IterativeGoalState,
  phaseAttemptId: string,
): Promise<void> {
  const nextPhase = stateNextPhase(state.phase);
  state.lock.phaseStatus = "transition_pending";
  stateManager.setPhase(nextPhase);
  stateManager.persistAll();

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase: nextPhase,
    phaseAttemptId, attempt: 1,
    kind: "next_phase_started", timestamp: new Date().toISOString(),
    details: { from: state.phase },
  });

  updateStatusBar(ctx, state);
  updateWidget(ctx, state);

  const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
  stateManager.setCapabilities(snapshot);
  const backends = detectSubagentBackend(pi, snapshot);

  await startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi, ctx);

  const prompt = renderPhasePrompt(nextPhase, state, snapshot, backends);
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  services.log(`Phase transition: ${state.phase} → ${nextPhase}`);
}

function getLastArtifactForPhase(
  state: IterativeGoalState,
  phase: Phase,
): PhaseArtifact | null {
  switch (phase) {
    case "research": return state.artifacts.research.at(-1) ?? null;
    case "plan": return state.artifacts.plans.at(-1) ?? null;
    case "implement": return state.artifacts.implementations.at(-1) ?? null;
    case "validate": return state.artifacts.validations.at(-1) ?? null;
  }
}

function getLastArtifactForPhaseCycle(
  state: IterativeGoalState,
  phase: Phase,
  cycle: number,
): PhaseArtifact | null {
  const artifact = getLastArtifactForPhase(state, phase);
  return artifact?.cycle === cycle ? artifact : null;
}

function isSyntheticCaptureFailure(artifact: PhaseArtifact | null): boolean {
  return artifact?.status === "failed_recoverable" && artifact.synthesis?.source === "synthetic_failure";
}
