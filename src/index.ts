/**
 * iterative-goal - Autonomous supervisor loop for Pi Coding Agent.
 *
 * Architecture:
 *   The extension owns a durable four-phase loop (research → plan →
 *   implement → validate/evaluate). It never voluntarily stops until
 *   an external evaluator returns goal_met: true.
 *
 * Key invariants (harness v3 — hardened):
 *   1. No stale queued phase may mutate a different run.
 *   2. No phase result is accepted unless runId + phaseAttemptId match the active lock.
 *   3. Synthesized artifacts are only recorded for the active phase attempt.
 *   4. Only the evaluator may declare goal completion.
 *   5. Every phase transition is backed by durable, run-scoped artifacts.
 *   6. Every file path written includes runId + cycle + phase.
 *   7. Old v1 state is migrated or rejected safely.
 *   8. Git finalization default-deny; produces patch without attempting git ops.
 *   9. /goal-status --json is authoritative for "is eval running?"
 *   10. Build + smoke pass before reporting completion.
 */

import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createStateManager,
  nextPhase as stateNextPhase,
  type StateManagerAPI,
} from "./state.js";
import { takeCapabilitySnapshot, detectSubagentBackend } from "./capabilities.js";
import { classifyError, createErrorRecord, getRecoveryAction } from "./errors.js";
import { registerGoalShellTool } from "./shell.js";
import { registerGoalSubagentTool } from "./subagents.js";
import {
  renderPhasePrompt,
  renderResumePrompt,
  renderCompactionSummary,
  generateValidationScript,
} from "./phases.js";
import { runExternalEvaluator } from "./evaluator.js";
import {
  updateStatusBar,
  updateWidget,
  clearStatusBar,
  registerDashboardCommands,
} from "./dashboard.js";
import {
  loadAwsCliConfig,
  preflightAwsCli,
  registerGoalAwsCliTool,
  withAwsCliPreflight,
} from "./aws-cli.js";
import {
  getGitCapability,
  loadFinalizationPolicy,
  registerGoalGitTool,
} from "./git.js";
import {
  type PhaseArtifact,
  type Phase,
  type PhaseLifecycleEvent,
  type IterativeGoalState,
  type CapabilitySnapshot,
} from "./types.js";
import {
  checkModelHealth,
  preflightAllModels,
  startPhaseAttempt,
} from "./kernel/workflow-engine.js";
import {
  getChangedFiles,
  getDiffStat,
  verifyImplementationAgainstPlan,
} from "./workspace/change-set.js";
import { registerGovernanceCommands } from "./ui/commands.js";
import { registerGoalCoreTools } from "./ui/tools.js";
import { registerToolInterception } from "./ui/tool-interception.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [core] ${msg}\n`);
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────

function getLastArtifactForPhase(
  state: ReturnType<StateManagerAPI["getState"]>,
  phase: Phase,
): PhaseArtifact | null {
  if (!state) return null;
  switch (phase) {
    case "research": return state.artifacts.research.at(-1) ?? null;
    case "plan": return state.artifacts.plans.at(-1) ?? null;
    case "implement": return state.artifacts.implementations.at(-1) ?? null;
    case "validate": return state.artifacts.validations.at(-1) ?? null;
  }
}

function getLastArtifactForPhaseCycle(
  state: ReturnType<StateManagerAPI["getState"]>,
  phase: Phase,
  cycle: number,
): PhaseArtifact | null {
  const artifact = getLastArtifactForPhase(state, phase);
  return artifact?.cycle === cycle ? artifact : null;
}

function normalizeContentParts(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!content || typeof content !== "object") return [];
  if ("type" in (content as Record<string, unknown>)) return [content];
  return [];
}

export function extractTextFromParts(content: unknown): string {
  const parts = normalizeContentParts(content);
  const text: string[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      text.push(record.text);
      continue;
    }
    if (typeof record.text === "string") {
      text.push(record.text);
    }
  }

  return text.join("").trim();
}

function extractToolCallsFromParts(content: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const parts = normalizeContentParts(content);
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "toolCall" && typeof record.name === "string") {
      toolCalls.push({
        name: record.name,
        args: record.arguments && typeof record.arguments === "object"
          ? record.arguments as Record<string, unknown>
          : {},
      });
    }
  }

  return toolCalls;
}

function isSyntheticCaptureFailure(artifact: PhaseArtifact | null): boolean {
  return artifact?.status === "failed_recoverable" && artifact.synthesis?.source === "synthetic_failure";
}

function refreshAwsCliConfig(
  state: IterativeGoalState,
  cwd: string,
): void {
  const currentPreflight = state.config.awsCli?.preflight ?? null;
  state.config.awsCli = {
    ...loadAwsCliConfig(cwd),
    preflight: currentPreflight,
  };
}

function refreshFinalizationPolicy(
  state: IterativeGoalState,
  cwd: string,
): void {
  state.finalizationPolicy = loadFinalizationPolicy(cwd);
  state.constraints.allowGitFinalization = state.finalizationPolicy.allowGitFinalization;
}

async function buildRuntimeCapabilitySnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  state?: IterativeGoalState | null,
): Promise<CapabilitySnapshot> {
  const snapshot = takeCapabilitySnapshot(pi);
  if (!state) return snapshot;

  refreshAwsCliConfig(state, ctx.cwd);
  refreshFinalizationPolicy(state, ctx.cwd);
  if (!state.config.awsCli.enabled) {
    snapshot.awsCli = null;
  } else {
    const preflight = await preflightAwsCli(pi, ctx, state.config.awsCli);
    state.config.awsCli = withAwsCliPreflight(state.config.awsCli, preflight);
    snapshot.awsCli = preflight;
  }
  snapshot.gitFinalization = await getGitCapability(pi, ctx, state.finalizationPolicy);
  return snapshot;
}

// ── Main Extension ──────────────────────────────────────────────────

export default function registerIterativeGoalExtension(pi: ExtensionAPI): void {
  log("=== Extension initializing (v3 hardened) ===");
  const stateManager = createStateManager(pi);

  // ── Register tools ───────────────────────────────────────────────

  registerGoalShellTool(
    pi,
    () => stateManager.getState()?.config.awsCli ?? null,
    () => stateManager.getState()?.finalizationPolicy ?? null,
  );
  registerGoalAwsCliTool(pi, stateManager);
  registerGoalGitTool(pi, stateManager);
  registerGoalSubagentTool(pi, () => stateManager.getState()?.capabilities ?? null);
  registerGoalCoreTools(pi, stateManager, { log });

  // ── Core loop motor ────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    log(`agent_end: runId=${state.runId} cycle=${state.cycle} phase=${state.phase}`);

    // Verify this run owns the lock
    if (state.lock.activeRunId !== state.runId) {
      log("agent_end: run does not own lock — skipping");
      return;
    }

    const phaseAttemptId = state.lock.activePhaseId || "";

    // Only record output receipt if lock is active
    if (!phaseAttemptId) {
      log("agent_end: no active phaseAttemptId — skipping synthesis");
      return;
    }

    stateManager.recordPhaseEvent({
      runId: state.runId, cycle: state.cycle, phase: state.phase,
      phaseAttemptId, attempt: state.phaseAttempts.filter(
        a => a.cycle === state.cycle && a.phase === state.phase,
      ).length + 1,
      kind: "phase_output_received", timestamp: new Date().toISOString(),
    });

    // Extract/synthesize only for the active phase attempt
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
        log(`Synthesized ${state.phase} result`);
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

      const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, state);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);
      await startPhaseAttempt(state, stateManager, state.phase, snapshot, pi, ctx);
      const prompt = renderPhasePrompt(state.phase, state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      log(`Retrying ${state.phase} after synthetic capture failure`);
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
      log(`Pausing ${state.phase} after repeated synthetic capture failure`);
      return;
    }

    // Complete the phase attempt
    stateManager.completePhaseAttempt(phaseAttemptId, "completed");

    // Implement-phase specific: verify diffs
    if (state.phase === "implement") {
      const diffInfo = await verifyImplementationAgainstPlan(state, stateManager);
      log(`Implement verify: ${diffInfo.changedFiles.length} changed, ${diffInfo.plannedFiles.length} planned, violation=${diffInfo.allowlistViolation}`);
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

    // Persist
    stateManager.recordPhaseEvent({
      runId: state.runId, cycle: state.cycle, phase: state.phase,
      phaseAttemptId, attempt: state.phaseAttempts.length,
      kind: "phase_result_committed", timestamp: new Date().toISOString(),
    });
    stateManager.persistAll();

    // ── Phase transition ───────────────────────────────────────────
    if (state.phase === "validate") {
      log(`Running external evaluator for cycle ${state.cycle}`);

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
        log(`GOAL MET after ${state.cycle} cycles`);
        return;
      }

      if (verdict.next_cycle_directive.focus === "external_blocked_complete") {
        stateManager.markCompletedBlocked();
        stateManager.releaseLock(state.runId, phaseAttemptId);
        updateStatusBar(ctx, state);
        updateWidget(ctx, state);

        const patchPath = stateManager.getArtifactPath(state.cycle, "validate", "final.patch");
        try {
          const { execSync } = require("node:child_process");
          const fs = require("node:fs");
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
        log(`COMPLETED_EXTERNAL_BLOCKERS after ${state.cycle} cycles`);
        return;
      }

      // goal_met=false → next cycle
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
      const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, state);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);

      await startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi, ctx);

      const prompt = renderPhasePrompt(nextPhase, state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      log(`Next cycle ${state.cycle} starting with ${nextPhase}`);
      return;
    }

    // Not validate → advance to next phase
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

    const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, state);
    stateManager.setCapabilities(snapshot);
    const backends = detectSubagentBackend(pi, snapshot);

    await startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi, ctx);

    const prompt = renderPhasePrompt(nextPhase, state, snapshot, backends);
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    log(`Phase transition: ${state.phase} → ${nextPhase}`);
  });

  // ── Session lifecycle ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start: reason=${(_event as any).reason}`);

    const restored = stateManager.restore(ctx);
    if (restored) {
      log(`Restored: runId=${restored.runId}, cycle=${restored.cycle}, status=${restored.status}`);

      updateStatusBar(ctx, restored);
      updateWidget(ctx, restored);

      if (restored.status === "running") {
        ctx.ui.notify(`Resuming iterative goal: cycle ${restored.cycle}, phase ${restored.phase}`, "info");

        const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, restored);
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
      log("Shutdown: state persisted with paused lock");
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const state = stateManager.getState();
    if (!state) return;
    const summary = renderCompactionSummary(state);
    stateManager.persistAll();
    return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });

  registerToolInterception(pi, stateManager, { log });

  // ── Commands ───────────────────────────────────────────────────

  pi.registerCommand("goal-start", {
    description: "Start an autonomous iterative goal loop",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (!trimmed) { ctx.ui.notify("Usage: /goal-start <goal> [#criterion: <criteria>]", "warning"); return; }

      let goal = trimmed;
      let criterion = "All explicit completion criteria are satisfied, validation passes, and state is reproducible.";
      const cm = trimmed.match(/#criterion:\s*(.+)/);
      if (cm) { criterion = cm[1].trim(); goal = trimmed.replace(cm[0], "").trim(); }

      const existing = stateManager.getState();
      if (existing && existing.status === "running") {
        const ok = await ctx.ui.confirm("Replace active goal?",
          `An iterative goal is already running: "${existing.goal}"\n\nStart a new one? Old queued phases will be cancelled.`);
        if (!ok) return;
        stateManager.cancelQueuedPhases(existing.runId);
        stateManager.releaseLock(existing.runId, existing.lock.activePhaseId ?? "");
      }

      // Preflight ALL configured models (not hardcoded)
      const state = stateManager.createRun(goal, criterion, {
        awsCli: loadAwsCliConfig(ctx.cwd),
      });
      refreshFinalizationPolicy(state, ctx.cwd);
      // Note: primary model is set by createRun, but we need the actual configured model
      // Re-read prefs from pi settings
      const modelHealth = await preflightAllModels(ctx,
        state.config.primaryModel,
        state.config.fallbackModels,
      );
      state.config.modelHealth = modelHealth;

      log(`Goal started: runId=${state.runId}, goal="${goal}"`);

      const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, state);
      stateManager.setCapabilities(snapshot);

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const backends = detectSubagentBackend(pi, snapshot);
      await startPhaseAttempt(state, stateManager, "research", snapshot, pi, ctx);

      // NOTE: startPhaseAttempt already calls acquireLock — do NOT re-acquire
      const prompt = renderPhasePrompt("research", state, snapshot, backends);
      pi.sendUserMessage(prompt);
      ctx.ui.notify(`Iterative goal started: cycle ${state.cycle}, phase research`);
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show status (--json for machine output)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify(args.includes("--json")
          ? JSON.stringify({ active: false }, null, 2) : "No active iterative goal. Start with /goal-start.", "info");
        return;
      }
      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      if (args.includes("--json")) {
        const es = state.evaluatorState;
        const latestArtifact = getLastArtifactForPhaseCycle(state, state.phase, state.cycle);
        const json = {
          active: true, runId: state.runId, goal: state.goal, goalCriterion: state.goalCriterion,
          status: state.status, cycle: state.cycle, phase: state.phase,
          lock: {
            activeRunId: state.lock.activeRunId, activePhaseId: state.lock.activePhaseId,
            phaseStatus: state.lock.phaseStatus, phaseStartedAt: state.lock.phaseStartedAt,
            queuedPhaseIds: state.lock.queuedPhaseIds,
          },
          evaluator: {
            model: `${state.evaluator.provider}/${state.evaluator.model}`,
            status: es?.status ?? "not_started",
            startedAt: es?.startedAt ?? null,
            lastHeartbeatAt: es?.lastHeartbeatAt ?? null,
            isStale: es?.lastHeartbeatAt ? (Date.now() - new Date(es.lastHeartbeatAt).getTime() > 120_000) : null,
            error: es?.error ?? null,
            lastVerdict: state.evaluator.lastVerdict ? {
              goal_met: state.evaluator.lastVerdict.goal_met,
              confidence: state.evaluator.lastVerdict.confidence,
              blockers: state.evaluator.lastVerdict.completion_blockers,
              next_focus: state.evaluator.lastVerdict.next_cycle_directive.focus,
            } : null,
          },
          artifacts: {
            research: state.artifacts.research.length, plans: state.artifacts.plans.length,
            implementations: state.artifacts.implementations.length, validations: state.artifacts.validations.length,
            evaluatorReports: state.artifacts.evaluatorReports.length,
          },
          errors: state.errors.length,
          unresolvedErrors: state.errors.filter(e => !e.resolved).map(e => ({
            phase: e.phase, kind: e.kind, cycle: e.cycle, recoveryAction: e.recoveryAction,
          })),
          modelHealth: state.config.modelHealth,
          awsCli: state.config.awsCli,
          finalizationPolicy: state.finalizationPolicy,
          releaseAuthorization: state.releaseAuthorization ? {
            id: state.releaseAuthorization.id,
            headSha: state.releaseAuthorization.headSha,
            expiresAt: state.releaseAuthorization.expiresAt,
            allowedAction: state.releaseAuthorization.allowedAction,
          } : null,
          phaseAttempts: state.phaseAttempts.slice(-5).map(a => ({
            phaseAttemptId: a.phaseAttemptId, cycle: a.cycle, phase: a.phase,
            attempt: a.attempt, status: a.status,
            model: `${a.modelProvider}/${a.modelModel}`, fallbackChain: a.fallbackChain,
          })),
          lastTransitionEvent: state.phaseAttempts.length > 0 ? {
            kind: state.phaseAttempts.at(-1)!.status,
            timestamp: state.phaseAttempts.at(-1)!.startedAt,
          } : null,
          latestArtifact: latestArtifact ? {
            phase: latestArtifact.phase,
            status: latestArtifact.status,
            source: latestArtifact.synthesis?.source ?? "unknown",
            nonceMatched: latestArtifact.synthesis?.nonceMatched ?? false,
            reason: latestArtifact.synthesis?.reason ?? null,
          } : null,
          artifactPaths: {
            research: state.artifacts.research.length > 0 ? stateManager.getArtifactPath(state.cycle, "research", "result.json") : null,
            plan: state.artifacts.plans.length > 0 ? stateManager.getArtifactPath(state.cycle, "plan", "result.json") : null,
            implement: state.artifacts.implementations.length > 0 ? stateManager.getArtifactPath(state.cycle, "implement", "result.json") : null,
            validate: state.artifacts.validations.length > 0 ? stateManager.getArtifactPath(state.cycle, "validate", "result.json") : null,
          },
        };
        ctx.ui.notify(JSON.stringify(json, null, 2), "info");
        return;
      }

      const s = state;
      const lines = [
        `Iterative Goal Status:`,
        `  Run ID: ${s.runId}`, `  Goal: ${s.goal}`, `  Criterion: ${s.goalCriterion}`,
        `  Status: ${s.status}`, `  Cycle: ${s.cycle}`, `  Phase: ${s.phase}`,
        `  Lock: ${s.lock.phaseStatus} (owner: ${s.lock.activePhaseId || "none"})`,
        `  Artifacts: R:${s.artifacts.research.length} P:${s.artifacts.plans.length} I:${s.artifacts.implementations.length} V:${s.artifacts.validations.length}`,
        `  Errors: ${s.errors.length}`,
      ];
      if (s.config.awsCli.enabled) {
        lines.push(
          `  AWS: profile=${s.config.awsCli.preflight?.resolvedProfile ?? "unresolved"} region=${s.config.awsCli.preflight?.resolvedRegion ?? s.config.awsCli.defaultRegion}`,
          `  AWS Issues: ${s.config.awsCli.preflight?.issues.length ?? 0}`,
        );
      }
      if (s.evaluatorState) {
        lines.push("", `  Evaluator: ${s.evaluatorState.status}`,
          `  Started: ${s.evaluatorState.startedAt ?? "never"}`, `  Heartbeat: ${s.evaluatorState.lastHeartbeatAt ?? "never"}`,
          s.evaluatorState.error ? `  Error: ${s.evaluatorState.error}` : "");
      }
      if (s.evaluator.lastVerdict) {
        const v = s.evaluator.lastVerdict;
        lines.push("", `  Last Verdict: goal_met=${v.goal_met}, confidence=${v.confidence}`,
          `  Blockers: ${v.completion_blockers.length}`, `  Next focus: ${v.next_cycle_directive.focus}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("goal-pause", {
    description: "Pause the loop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state || state.status !== "running") { ctx.ui.notify("No active goal to pause.", "warning"); return; }
      stateManager.setStatus("paused_by_user");
      updateStatusBar(ctx, state); updateWidget(ctx, state);
      ctx.ui.notify(`Goal paused at cycle ${state.cycle}. Use /goal-resume.`, "info");
      log("Paused by user");
    },
  });

  pi.registerCommand("goal-resume", {
    description: "Resume paused loop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state || state.status !== "paused_by_user") { ctx.ui.notify("No paused goal.", "warning"); return; }
      stateManager.setStatus("running");
      updateStatusBar(ctx, state); updateWidget(ctx, state);

      const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, state);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);
      await startPhaseAttempt(state, stateManager, state.phase, snapshot, pi, ctx);
      const prompt = renderResumePrompt(state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify(`Resuming: cycle ${state.cycle}, phase ${state.phase}`, "info");
      log("Resumed");
    },
  });

  pi.registerCommand("goal-repair-capabilities", {
    description: "Run capability preflight and fix",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const snapshot = await buildRuntimeCapabilitySnapshot(pi, ctx, state);
      stateManager.setCapabilities(snapshot);
      const issues: string[] = [];
      if (!snapshot.hasBashTool) issues.push("bash unavailable (goal_shell available)");
      if (!snapshot.hasSubagentTool && !snapshot.hasAgentTool) issues.push("no subagent backend");
      if (snapshot.awsCli?.enabled) {
        issues.push(...snapshot.awsCli.issues.map((issue) => `aws: ${issue}`));
      }
      ctx.ui.notify(issues.length === 0 ? "Capabilities good." : `Issues:\n${issues.map(i => `  - ${i}`).join("\n")}`, issues.length === 0 ? "info" : "warning");

      for (const fb of state.config.fallbackModels) {
        const health = await checkModelHealth(ctx, fb.provider, fb.model);
        state.config.modelHealth[`${fb.provider}/${fb.model}`] = health;
        if (health.lastStatus === "available") {
          const model = ctx.modelRegistry.find(fb.provider, fb.model);
          if (model) { await pi.setModel(model); ctx.ui.notify(`Switched to: ${fb.provider}/${fb.model}`, "info"); break; }
        }
      }
      updateStatusBar(ctx, state); updateWidget(ctx, state);
    },
  });

  pi.registerCommand("goal-finalize", {
    description: "Finalize: generate patch. --mode patch (default).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }

      // git is ALWAYS denied unless explicitly enabled by policy
      if (!state.finalizationPolicy.allowGitFinalization && !state.finalizationPolicy.allowCommit) {
        const patchPath = stateManager.getArtifactPath(state.cycle, state.phase, "final.patch");
        try {
          const { execSync } = require("node:child_process");
          const fs = require("node:fs");
          const patch = execSync("git diff", { encoding: "utf-8", timeout: 10_000 });
          fs.writeFileSync(patchPath, patch);

          // Also generate PR description
          const prDescPath = stateManager.getArtifactPath(state.cycle, state.phase, "pr-description.md");
          const prDesc = [
            `# ${state.goal}`, "",
            `**Run ID**: ${state.runId}`, `**Cycles**: ${state.cycle}`,
            state.evaluator.lastVerdict ? `**Verdict**: goal_met=${state.evaluator.lastVerdict.goal_met} confidence=${state.evaluator.lastVerdict.confidence}` : "**Verdict**: not yet evaluated",
            "", "## Changed Files",
            ...(await getChangedFiles()).map(f => `- ${f}`),
            "", "## Diff Stat", "",
            await getDiffStat(), "",
            "## Safety Notes",
            state.evaluator.lastVerdict?.safety_notes.map(n => `- ${n}`).join("\n") || "- None",
            "",
            `Patch: \`${patchPath}\``,
          ].join("\n");
          fs.writeFileSync(prDescPath, prDesc);

          ctx.ui.notify(`Patch: ${patchPath}\nPR description: ${prDescPath}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed: ${err.message}`, "error");
        }
        return;
      }

      const modeMatch = args.match(/--mode\s+(\w+)/);
      const mode = modeMatch?.[1] ?? "patch";
      if (mode === "patch") {
        const patchPath = stateManager.getArtifactPath(state.cycle, state.phase, "final.patch");
        try {
          const { execSync } = require("node:child_process");
          const fs = require("node:fs");
          fs.writeFileSync(patchPath, execSync("git diff", { encoding: "utf-8", timeout: 10_000 }));
          ctx.ui.notify(`Patch: ${patchPath}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed: ${err.message}`, "error");
        }
        return;
      }
      if (mode === "commit" && state.finalizationPolicy.allowCommit) {
        ctx.ui.notify("Git finalization enabled by policy. Use goal_git for staged commit/push/PR actions.", "info");
        return;
      }
      ctx.ui.notify("Requested finalization mode is not allowed by policy.", "warning");
    },
  });

  registerGovernanceCommands(pi, stateManager);

  pi.registerCommand("goal-reset", {
    description: "Reset state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const ok = await ctx.ui.confirm("Reset?", `Clear goal "${state.goal}" and all artifacts?`);
      if (!ok) return;

      // Archive active-run.json so it cannot be restored
      archiveActiveRun();
      stateManager.clear();
      clearStatusBar(ctx);
      ctx.ui.notify("Iterative goal reset.", "info");
      log("Reset by user");
    },
  });

  registerDashboardCommands(pi, stateManager);
}

// ── Helper: archive active-run.json ─────────────────────────────────

function archiveActiveRun(): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const activePath = path.join(process.cwd(), ".pi", "iterative-goal", "active-run.json");
    if (fs.existsSync(activePath)) {
      const legacyDir = path.join(process.cwd(), ".pi", "iterative-goal", "legacy");
      fs.mkdirSync(legacyDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(activePath, path.join(legacyDir, `active-run-${ts}.json`));
    }
  } catch {}
}

// ── Helper: get changed files for PR description ────────────────────

// ── Safe synthesis (with nonce matching) ──────────────────────────

export function synthesizePhaseResultSafe(
  event: any,
  phase: Phase,
  cycle: number,
  runId: string,
  phaseAttemptId: string,
): (PhaseArtifact & { _nonceMatched?: boolean }) | null {
  const messages = event.messages;
  if (!messages || messages.length === 0) return null;

  let lastAssistantText = "";
  let lastAssistantToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolErrors: Array<{ name: string; error: string }> = [];
  let nonceMatched = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const assistantText = extractTextFromParts(msg.content);
      const toolCalls = extractToolCallsFromParts(msg.content);
      for (const toolCall of toolCalls) {
        if (toolCall.args.runId === runId && toolCall.args.phaseAttemptId === phaseAttemptId) {
          nonceMatched = true;
        }
      }
      if (assistantText || toolCalls.length > 0) {
        lastAssistantText = assistantText;
        lastAssistantToolCalls = toolCalls;
        break;
      }
    }
    if (msg.role === "toolResult" && msg.isError) {
      toolErrors.push({
        name: msg.toolName || "unknown",
        error: extractTextFromParts(msg.content) || JSON.stringify(msg.content).slice(0, 500),
      });
    }
  }

  if (!lastAssistantText && lastAssistantToolCalls.length === 0) {
    return {
      phase, cycle,
      status: "failed_recoverable",
      content: `No output detected from model during ${phase} phase. Possible provider/tool incompatibility.`,
      timestamp: new Date().toISOString(), toolCalls: [], toolErrors,
      synthesis: {
        source: "synthetic_failure",
        nonceMatched: false,
        reason: "assistant_output_missing",
      },
      _nonceMatched: false,
    };
  }

  return {
    phase, cycle,
    status: "completed",
    content: lastAssistantText || `${lastAssistantToolCalls.length} tool calls without text output.`,
    timestamp: new Date().toISOString(), toolCalls: lastAssistantToolCalls, toolErrors,
    synthesis: {
      source: lastAssistantText ? "assistant_text" : "assistant_tool_calls",
      nonceMatched,
      reason: nonceMatched ? undefined : "assistant_output_without_matching_harness_nonce",
    },
    _nonceMatched: nonceMatched,
  };
}
