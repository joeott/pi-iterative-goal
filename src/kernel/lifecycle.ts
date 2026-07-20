import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectSubagentBackend } from "../capabilities.js";
import { createErrorRecord } from "../errors.js";
import { findUnfinishedWork, runExternalEvaluator } from "../evaluator.js";
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
import { loadMergeBackConfig, recoverWorktrees, runMergeBackHook } from "../workspace/worktrees.js";
import { shutdownRunAgentPools } from "../agents/run-pool.js";
import { runSharderHook } from "./sharder.js";
import { type ShardExecutionReport, runSchedulerHook } from "./scheduler.js";
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

    // C4-ADV-004: scoped worktree crash recovery on every session start —
    // harness-prefixed registrations from dead runs are reclaimed (surviving
    // directories included) before anything can wedge on them. Recovery is
    // an observer here: its own failure must never block a restore.
    try {
      const recovery = recoverWorktrees(ctx.cwd);
      if (recovery.pruned.length > 0 || recovery.reclaimed.length > 0) {
        services.log(`worktree recovery: ${recovery.pruned.length} pruned, ${recovery.reclaimed.length} reclaimed (${recovery.skippedForeign.length} foreign left alone)`);
      }
    } catch (err) {
      services.log(`worktree recovery skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    const restored = stateManager.restore(ctx);
    if (restored) {
      services.log(`Restored: runId=${restored.runId}, cycle=${restored.cycle}, status=${restored.status}`);

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

  if (verdict.goal_met === true) {
    stateManager.markSucceeded();
    stateManager.releaseLock(state.runId, phaseAttemptId);
    // Run boundary: tear down the run's swarm pool with the run (C1-ADV-003).
    await shutdownRunAgentPools();
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
    // Run boundary: tear down the run's swarm pool with the run (C1-ADV-003).
    await shutdownRunAgentPools();

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

  // C2 sharder attach seam (§6.1): at the exact plan→implement transition,
  // evaluate the typed plan posted via goal_post_shards and commit
  // shard_posted. Flag-gated inside runSharderHook (default OFF — the
  // free-text plan + checklist path is untouched); a sharder failure must
  // never wedge the loop motor, so it degrades to single-slice.
  if (state.phase === "plan" && nextPhase === "implement") {
    try {
      runSharderHook({ stateManager, cwd: ctx.cwd, log: services.log, phaseAttemptId });
    } catch (err) {
      services.log(`Sharder hook failed (implement continues single-slice): ${err instanceof Error ? err.message : String(err)}`);
      // Degradation observability (C2-ADV-006): the decline is visible, not silent.
      ctx.ui.notify("Iterative goal sharder failed; implement phase continues single-slice.", "warning");
    }

    // C3 scheduler attach seam (§6.4–6.5, C3-ADV-001): same transition,
    // immediately after the sharder — when the sharder just committed a
    // fan_out plan (or one is already ledgered for this cycle), schedule and
    // execute it through dispatchAgentTask. Flag-gated inside
    // runSchedulerHook (default OFF — returns before touching anything, so
    // flag-off behavior is byte-identical); a scheduler failure degrades to
    // the single-slice implement prompt, never wedges the loop motor.
    let schedulerReport: ShardExecutionReport | null = null;
    try {
      schedulerReport = await runSchedulerHook({ stateManager, cwd: ctx.cwd, log: services.log });
    } catch (err) {
      services.log(`Scheduler hook failed (implement continues single-slice): ${err instanceof Error ? err.message : String(err)}`);
      ctx.ui.notify("Iterative goal scheduler failed; implement phase continues single-slice.", "warning");
    }

    // C4 merge-back attach seam (§6.6): same transition, immediately after
    // the scheduler — the completed shards' captured patches merge onto the
    // integration branch in HEFT order through the three-part merge gate.
    // Flag-gated inside runMergeBackHook (default OFF — returns before
    // touching anything, so flag-off behavior is byte-identical); a merge
    // failure degrades to the single-slice implement prompt, never wedges
    // the loop motor.
    try {
      // The snapshot closure reads the REAL flag value (C4-OUS-007) and the
      // merge layer passes the shard being verified so the recorded evidence
      // is the post-verdict view (C4-OUS-006).
      const mergeBackEnabled = loadMergeBackConfig(ctx.cwd).enabled;
      await runMergeBackHook({
        stateManager,
        cwd: ctx.cwd,
        schedulerReport,
        mergeBackEnabled,
        // Gate part 3 evidence snapshot (§6.6): the evaluator's extended
        // unfinished-work gate, shared so merge-time evidence and the
        // validate-phase gate read the same predicate.
        snapshotUnfinishedWork: (excludeShardId) => {
          const current = stateManager.getState();
          if (!current) return { pendingTaskItems: 0, unverifiedShards: 0 };
          const items = findUnfinishedWork(current, { mergeBackEnabled })
            .filter((item) => !(item.kind === "shard" && item.id === excludeShardId));
          return {
            pendingTaskItems: items.filter((item) => item.kind === "task").length,
            unverifiedShards: items.filter((item) => item.kind === "shard").length,
          };
        },
        log: services.log,
      });
    } catch (err) {
      services.log(`Merge-back hook failed (implement continues single-slice): ${err instanceof Error ? err.message : String(err)}`);
      ctx.ui.notify("Iterative goal merge-back failed; implement phase continues single-slice.", "warning");
    }
  }

  state.lock.phaseStatus = "transition_pending";
  stateManager.setPhase(nextPhase);
  stateManager.persistAll();

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase: nextPhase,
    phaseAttemptId, attempt: 1,
    kind: "next_phase_started", timestamp: new Date().toISOString(),
    details: { from: state.phase },
  });

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
