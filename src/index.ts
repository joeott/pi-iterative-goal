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
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
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
import { checkCommand } from "./safety.js";
import {
  type PhaseArtifact,
  type Phase,
  type PhaseAttempt,
  type PhaseLifecycleEvent,
  type ModelHealthEntry,
  type IterativeGoalState,
  type CapabilitySnapshot,
  PHASE_ORDER,
  PhaseResultParams,
} from "./types.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [core] ${msg}\n`);
  } catch {}
}

// ── Stale-write guard ──────────────────────────────────────────────

/** Returns null if the write is authorized, or a rejection reason string. */
function checkStaleWriteGuard(
  state: IterativeGoalState | null,
  params: { runId?: string; phaseAttemptId?: string },
  action: string,
): string | null {
  if (!state) return `No active state for ${action}`;
  if (state.status !== "running" && action !== "goal_checkpoint") {
    return `Run not running (status=${state.status}) for ${action}`;
  }
  if (params.runId && params.runId !== state.runId) {
    return `runId mismatch: got ${params.runId}, expected ${state.runId} for ${action}`;
  }
  if (params.phaseAttemptId && state.lock.activePhaseId && params.phaseAttemptId !== state.lock.activePhaseId) {
    return `phaseAttemptId mismatch: got ${params.phaseAttemptId}, expected ${state.lock.activePhaseId} for ${action}`;
  }
  return null;
}

/** Emits a stale-output-ignored event and returns the rejection text. */
function rejectStale(
  stateManager: StateManagerAPI,
  state: IterativeGoalState,
  reason: string,
  params: { runId?: string; phaseAttemptId?: string },
): string {
  stateManager.recordPhaseEvent({
    runId: state.runId,
    cycle: state.cycle,
    phase: state.phase,
    phaseAttemptId: state.lock.activePhaseId ?? "",
    attempt: state.phaseAttempts.filter(a =>
      a.cycle === state.cycle && a.phase === state.phase
    ).length + 1,
    kind: "stale_phase_output_ignored",
    timestamp: new Date().toISOString(),
    details: {
      reason,
      expectedRunId: state.runId,
      expectedPhaseAttemptId: state.lock.activePhaseId,
      observedRunId: params.runId ?? null,
      observedPhaseAttemptId: params.phaseAttemptId ?? null,
    },
  });
  return `STALE OUTPUT REJECTED: ${reason}. Active run=${state.runId}, activePhase=${state.lock.activePhaseId}. Your message is from a previous turn and has been ignored.`;
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

// ── Diff verification ────────────────────────────────────────────

async function verifyImplementationAgainstPlan(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
): Promise<{
  changedFiles: string[];
  diffStat: string;
  allowlistViolation: boolean;
  plannedFiles: string[];
  extraFiles: string[];
}> {
  // Capture actual changed files via git
  let changedFiles: string[] = [];
  let diffStat = "";
  try {
    const { execSync } = require("node:child_process");
    changedFiles = execSync("git diff --name-only", { encoding: "utf-8", timeout: 10_000 })
      .trim().split("\n").filter(Boolean);
    diffStat = execSync("git diff --stat", { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    log("git diff failed — cannot verify implementation");
    return { changedFiles: [], diffStat: "", allowlistViolation: false, plannedFiles: [], extraFiles: [] };
  }

  // Write diff patch to run-scoped directory
  const patchPath = stateManager.getArtifactPath(state.cycle, "implement", "diff.patch");
  try {
    const fs = require("node:fs");
    const { execSync } = require("node:child_process");
    fs.writeFileSync(patchPath, execSync("git diff", { encoding: "utf-8", timeout: 10_000 }));
  } catch {}

  // Parse plan allowlist from most recent plan artifact
  const lastPlan = state.artifacts.plans.at(-1);
  const plannedFiles = extractPlannedFiles(lastPlan?.content ?? "");

  // Check for out-of-allowlist files
  const extraFiles = changedFiles.filter(f => !isFileInAllowlist(f, plannedFiles));

  // Persist verification result
  const verifyPath = stateManager.getArtifactPath(state.cycle, "implement", "implementation-verification.json");
  try {
    const fs = require("node:fs");
    fs.writeFileSync(verifyPath, JSON.stringify({
      runId: state.runId,
      cycle: state.cycle,
      phase: "implement",
      changedFiles,
      diffStat,
      plannedFiles,
      extraFiles,
      allowlistViolation: extraFiles.length > 0,
      verifiedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}

  log(
    `Implementation verification: ${changedFiles.length} changed, ${plannedFiles.length} planned, ${extraFiles.length} extra — violation=${extraFiles.length > 0}`,
  );

  return {
    changedFiles,
    diffStat,
    allowlistViolation: extraFiles.length > 0,
    plannedFiles,
    extraFiles,
  };
}

function extractPlannedFiles(planContent: string): string[] {
  const files = new Set<string>();
  // Match explicit file paths in plans: backtick-wrapped, quoted, or path-like
  for (const p of [
    /`([a-zA-Z0-9_\-/.]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html|sql))`/g,
    /["']([a-zA-Z0-9_\-/.]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html|sql))["']/g,
    /(?:^|\s)([a-zA-Z0-9_\-/]{2,}\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html|sql))(?:$|\s|[,;])/gm,
  ]) {
    for (const m of planContent.matchAll(p)) {
      const file = m[1].trim();
      if (file.includes("/") || file.includes(".")) files.add(file);
    }
  }
  return [...files];
}

function isFileInAllowlist(file: string, planned: string[]): boolean {
  for (const p of planned) {
    if (file === p || file.endsWith("/" + p) || p.endsWith(file) || file.includes(p) || p.includes(file)) {
      return true;
    }
  }
  return false;
}

// ── Model health ───────────────────────────────────────────────────

async function checkModelHealth(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<ModelHealthEntry> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return { model: modelId, provider, lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(), error: "Model not found in registry",
      cooldownUntil: new Date(Date.now() + 300_000).toISOString() };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { model: modelId, provider, lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(), error: "Auth failed or no API key",
      cooldownUntil: new Date(Date.now() + 300_000).toISOString() };
  }
  try {
    const { complete } = require("@earendil-works/pi-ai");
    await complete(model, {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Say OK." }], timestamp: Date.now() }],
      systemPrompt: "",
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1, signal: AbortSignal.timeout(15_000) });
    return { model: modelId, provider, lastStatus: "available",
      lastCheckedAt: new Date().toISOString(), error: null, cooldownUntil: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Model health check failed for ${provider}/${modelId}: ${msg}`);
    return { model: modelId, provider, lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(), error: msg,
      cooldownUntil: new Date(Date.now() + 300_000).toISOString() };
  }
}

async function preflightAllModels(
  ctx: ExtensionContext,
  primary: { provider: string; model: string },
  fallbacks: Array<{ provider: string; model: string }>,
): Promise<Record<string, ModelHealthEntry>> {
  const health: Record<string, ModelHealthEntry> = {};
  const models = [primary, ...fallbacks];
  for (const m of models) {
    const key = `${m.provider}/${m.model}`;
    health[key] = await checkModelHealth(ctx, m.provider, m.model);
    log(`Model preflight ${key}: ${health[key].lastStatus}`);
  }
  return health;
}

function isModelInCooldown(health: ModelHealthEntry | undefined): boolean {
  if (!health || health.lastStatus !== "unavailable" || !health.cooldownUntil) return false;
  return new Date(health.cooldownUntil) > new Date();
}

function findFirstHealthyFallback(
  state: IterativeGoalState,
  fallbackChain?: Array<{ provider: string; model: string }>,
): { provider: string; model: string } | null {
  for (const fb of state.config.fallbackModels) {
    const key = `${fb.provider}/${fb.model}`;
    if (isModelInCooldown(state.config.modelHealth[key])) continue;
    if (fallbackChain && fallbackChain.some(f => f.provider === fb.provider && f.model === fb.model)) continue;
    return fb;
  }
  return null;
}

// ── Main Extension ──────────────────────────────────────────────────

export default function registerIterativeGoalExtension(pi: ExtensionAPI): void {
  log("=== Extension initializing (v3 hardened) ===");
  const stateManager = createStateManager(pi);

  // ── Register tools ───────────────────────────────────────────────

  registerGoalShellTool(pi);
  registerGoalSubagentTool(pi, () => stateManager.getState()?.capabilities ?? null);

  // goal_report_phase_result — hardened with stale-write guards
  pi.registerTool({
    name: "goal_report_phase_result",
    label: "Report Phase Result",
    description: "MANDATORY: Call at end of each phase. Must include runId and phaseAttemptId from the phase prompt's [HARNESS_META] block.",
    promptSnippet: "Report completion of an iterative-goal phase",
    promptGuidelines: [
      "ALWAYS call goal_report_phase_result at end of every phase. Include runId and phaseAttemptId from the [HARNESS_META] block in the phase prompt. Without these, the call is rejected as stale.",
    ],
    parameters: PhaseResultParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = stateManager.getState();

      // Guard: reject stale writes
      const rejectReason = checkStaleWriteGuard(state, params as any, "goal_report_phase_result");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state!, rejectReason, params as any) }],
          details: { rejected: true, reason: rejectReason },
        };
      }

      const s = state!;
      const phase = params.phase as Phase;
      const artifact: PhaseArtifact = {
        phase, cycle: s.cycle,
        status: (params.status as PhaseArtifact["status"]) ?? "completed",
        content: params.summary ?? "",
        timestamp: new Date().toISOString(),
        toolCalls: [], toolErrors: [],
      };

      stateManager.recordArtifact(artifact);
      stateManager.recordPhaseEvent({
        runId: s.runId, cycle: s.cycle, phase,
        phaseAttemptId: params.phaseAttemptId as string,
        attempt: s.phaseAttempts.filter(a => a.cycle === s.cycle && a.phase === phase).length + 1,
        kind: "phase_result_committed", timestamp: new Date().toISOString(),
        details: { status: artifact.status },
      });

      log(`Phase result recorded: ${phase} cycle=${s.cycle} status=${artifact.status}`);

      for (const err of s.errors) {
        if (err.phase === phase && err.cycle === s.cycle) err.resolved = true;
      }

      return {
        content: [{ type: "text" as const,
          text: `Phase '${phase}' result recorded for cycle ${s.cycle}. Status: ${artifact.status}.` }],
        details: artifact as unknown as Record<string, unknown>,
      };
    },
  });

  // goal_record_blocker — hardened with stale-write guards
  pi.registerTool({
    name: "goal_record_blocker", label: "Record Blocker",
    description: "Record a blocker. Must include runId and phaseAttemptId from [HARNESS_META].",
    parameters: Type.Object({
      runId: Type.String({ description: "MUST match [HARNESS_META] runId" }),
      phaseAttemptId: Type.String({ description: "MUST match [HARNESS_META] phaseAttemptId" }),
      phase: StringEnum([...PHASE_ORDER] as const),
      title: Type.String(), description: Type.String(),
      severity: StringEnum(["critical", "high", "medium", "low"] as const, { default: "high" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = stateManager.getState();
      const rejectReason = checkStaleWriteGuard(state, params as any, "goal_record_blocker");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state!, rejectReason, params as any) }],
          details: { rejected: true, reason: rejectReason },
        };
      }

      const error = createErrorRecord(
        `[BLOCKER] ${params.title}: ${params.description}`,
        params.phase as Phase, state!.cycle,
      );
      stateManager.recordError(error);

      return {
        content: [{ type: "text" as const,
          text: `Blocker recorded: ${params.title} (${params.severity}).` }],
        details: error as unknown as Record<string, unknown>,
      };
    },
  });

  // goal_request_capability_repair — hardened
  pi.registerTool({
    name: "goal_request_capability_repair", label: "Request Capability Repair",
    description: "Request that a missing capability be restored.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "MUST match [HARNESS_META] runId if the prompt contains one" })),
      what: Type.String({ description: "What is missing" }),
      kind: StringEnum(["tool_missing", "model_incompatible", "mcp_server_missing"] as const),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      log(`Capability repair requested: ${params.what} (${params.kind})`);

      // Guard: verify runId if provided (best-effort since this tool predates guard)
      const state = stateManager.getState();
      if (state && params.runId && params.runId !== state.runId) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state, `runId mismatch`, { runId: params.runId }) }],
          details: { rejected: true },
        };
      }

      if (params.kind === "model_incompatible" && state && state.config.fallbackModels.length > 0) {
        const fallback = findFirstHealthyFallback(state);
        if (fallback) {
          const model = ctx.modelRegistry.find(fallback.provider, fallback.model);
          if (model) {
            await pi.setModel(model);

            const currentAttempt = state.phaseAttempts.at(-1);
            if (currentAttempt) {
              currentAttempt.fallbackChain.push({
                provider: fallback.provider, model: fallback.model, reason: "model_incompatible",
              });
            }

            stateManager.recordPhaseEvent({
              runId: state.runId, cycle: state.cycle, phase: state.phase,
              phaseAttemptId: currentAttempt?.phaseAttemptId ?? "",
              attempt: currentAttempt?.attempt ?? 1,
              kind: "model_fallback", timestamp: new Date().toISOString(),
              details: {
                from: `${state.config.primaryModel.provider}/${state.config.primaryModel.model}`,
                to: `${fallback.provider}/${fallback.model}`, reason: "model_incompatible",
              },
            });

            return {
              content: [{ type: "text" as const,
                text: `Switched to fallback: ${fallback.provider}/${fallback.model}. Retry the phase.` }],
              details: {},
            };
          }
        }
      }

      return {
        content: [{ type: "text" as const,
          text: `Capability repair for '${params.what}' recorded. Addressed after evaluation.` }],
        details: {},
      };
    },
  });

  // goal_checkpoint
  pi.registerTool({
    name: "goal_checkpoint", label: "Goal Checkpoint",
    description: "Force a state checkpoint.",
    parameters: Type.Object({}),
    async execute() {
      stateManager.persistAll();
      return { content: [{ type: "text" as const, text: "State checkpoint created." }], details: {} };
    },
  });

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
    const lastArtifact = getLastArtifactForPhase(state, state.phase);
    if (!lastArtifact) {
      const synthesized = synthesizePhaseResultSafe(event, state.phase, state.cycle, phaseAttemptId);
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
      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);

      startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi);

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

    const snapshot = takeCapabilitySnapshot(pi);
    stateManager.setCapabilities(snapshot);
    const backends = detectSubagentBackend(pi, snapshot);

    startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi);

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

        const snapshot = takeCapabilitySnapshot(pi);
        stateManager.setCapabilities(snapshot);
        const backends = detectSubagentBackend(pi, snapshot);

        startPhaseAttempt(restored, stateManager, restored.phase, snapshot, pi);

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

  // ── Tool interception ──────────────────────────────────────────

  pi.on("tool_call", async (event) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    if (event.toolName === "bash") {
      const command = event.input?.command as string | undefined;
      if (command) {
        const result = checkCommand(command, state.constraints.allowDestructiveOps, state.finalizationPolicy.allowGitFinalization);
        if (!result.allowed) {
          log(`Blocked bash: ${result.reason}`);
          let suggestion = "";
          if (command.match(/\bgit\s+(add|commit)\b/) && !state.finalizationPolicy.allowGitFinalization) {
            const patchPath = stateManager.getArtifactPath(state.cycle, state.phase, "final.patch");
            suggestion = `\n\nGit finalization disabled. Patch: git diff > ${patchPath}`;
          }
          return { block: true, reason: (result.reason ?? "") + suggestion };
        }
      }
    }
  });

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
      const state = stateManager.createRun(goal, criterion);
      // Note: primary model is set by createRun, but we need the actual configured model
      // Re-read prefs from pi settings
      const modelHealth = await preflightAllModels(ctx,
        state.config.primaryModel,
        state.config.fallbackModels,
      );
      state.config.modelHealth = modelHealth;

      log(`Goal started: runId=${state.runId}, goal="${goal}"`);

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const backends = detectSubagentBackend(pi, snapshot);
      startPhaseAttempt(state, stateManager, "research", snapshot, pi);

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
          finalizationPolicy: state.finalizationPolicy,
          phaseAttempts: state.phaseAttempts.slice(-5).map(a => ({
            phaseAttemptId: a.phaseAttemptId, cycle: a.cycle, phase: a.phase,
            attempt: a.attempt, status: a.status,
            model: `${a.modelProvider}/${a.modelModel}`, fallbackChain: a.fallbackChain,
          })),
          lastTransitionEvent: state.phaseAttempts.length > 0 ? {
            kind: state.phaseAttempts.at(-1)!.status,
            timestamp: state.phaseAttempts.at(-1)!.startedAt,
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

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);
      startPhaseAttempt(state, stateManager, state.phase, snapshot, pi);
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
      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const issues: string[] = [];
      if (!snapshot.hasBashTool) issues.push("bash unavailable (goal_shell available)");
      if (!snapshot.hasSubagentTool && !snapshot.hasAgentTool) issues.push("no subagent backend");
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

      // Git enabled in policy (rare / operator-authorized only)
      ctx.ui.notify("Git finalization enabled by policy — not yet automated. Use /goal-finalize for patch output.", "warning");
    },
  });

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

async function getChangedFiles(): Promise<string[]> {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git diff --name-only", { encoding: "utf-8", timeout: 10_000 })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
}

async function getDiffStat(): Promise<string> {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git diff --stat", { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch { return "unavailable"; }
}

// ── Phase attempt helper ─────────────────────────────────────────

function startPhaseAttempt(
  state: IterativeGoalState | null,
  stateManager: StateManagerAPI,
  phase: Phase,
  snapshot: CapabilitySnapshot | null,
  pi: ExtensionAPI,
): void {
  if (!state) return;

  const existingAttempts = state.phaseAttempts.filter(
    (a: PhaseAttempt) => a.cycle === state.cycle && a.phase === phase,
  );
  const attemptNum = existingAttempts.length + 1;
  const phaseAttemptId = `${state.runId}/c${state.cycle}/${phase}/a${attemptNum}`;

  // Check model health for primary; auto-fallback if unavailable
  const primaryKey = `${state.config.primaryModel.provider}/${state.config.primaryModel.model}`;
  const primaryHealth = state.config.modelHealth[primaryKey];
  let effectiveModel = state.config.primaryModel;
  const fallbackChain: Array<{ provider: string; model: string; reason: string }> = [];

  if (isModelInCooldown(primaryHealth)) {
    log(`Primary model ${primaryKey} in cooldown — searching fallbacks`);
    const fb = findFirstHealthyFallback(state);
    if (fb) {
      fallbackChain.push({ ...effectiveModel, reason: `${primaryKey} in cooldown` });
      effectiveModel = fb;
      log(`Using fallback: ${fb.provider}/${fb.model}`);
    }
  }

  const attempt: PhaseAttempt = {
    runId: state.runId, cycle: state.cycle, phase, attempt: attemptNum,
    phaseAttemptId,
    modelProvider: effectiveModel.provider, modelModel: effectiveModel.model,
    fallbackChain,
    startedAt: new Date().toISOString(),
    status: "running",
    outputReceived: false, resultParsed: false, artifactsPersisted: false, resultCommitted: false,
  };

  stateManager.startPhaseAttempt(attempt);
  stateManager.acquireLock(state.runId, phaseAttemptId);

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase, phaseAttemptId, attempt: attemptNum,
    kind: "phase_started", timestamp: new Date().toISOString(),
    details: { model: `${effectiveModel.provider}/${effectiveModel.model}` },
  });

  stateManager.recordPhaseEvent({
    runId: state.runId, cycle: state.cycle, phase, phaseAttemptId, attempt: attemptNum,
    kind: "tool_preflight_recorded", timestamp: new Date().toISOString(),
    details: { activeTools: snapshot?.activeTools ?? [] },
  });
}

// ── Safe synthesis (with nonce matching) ──────────────────────────

function synthesizePhaseResultSafe(
  event: any,
  phase: Phase,
  cycle: number,
  phaseAttemptId: string,
): (PhaseArtifact & { _nonceMatched?: boolean }) | null {
  const messages = event.messages;
  if (!messages || messages.length === 0) return null;

  // Extract the nonce from the most recent assistant message
  // The nonce is embedded in the prompt as: [HARNESS_META] ... phaseNonce=<uuid>
  let lastAssistantText = "";
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolErrors: Array<{ name: string; error: string }> = [];
  let nonceMatched = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content || []) {
        if (part.type === "text") {
          lastAssistantText = part.text || "";
          break;
        }
        if (part.type === "toolCall") {
          // Check if tool call includes the correct runId/phaseAttemptId
          const args = part.arguments || {};
          if (args.runId && args.phaseAttemptId) {
            const toolAttemptStr = `${args.runId}/${args.phaseAttemptId}`;
            if (toolAttemptStr === `${event._runId || ""}/${phaseAttemptId}`) {
              nonceMatched = true;
            }
          }
          toolCalls.push({ name: part.name, args });
        }
      }
      if (lastAssistantText) break;
    }
    if (msg.role === "toolResult" && msg.isError) {
      toolErrors.push({
        name: msg.toolName || "unknown",
        error: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content).slice(0, 500),
      });
    }
  }

  if (!lastAssistantText && toolCalls.length === 0) {
    return {
      phase, cycle,
      status: "failed_recoverable",
      content: `No output detected from model during ${phase} phase. Possible provider/tool incompatibility.`,
      timestamp: new Date().toISOString(), toolCalls: [], toolErrors,
      _nonceMatched: false,
    };
  }

  return {
    phase, cycle,
    status: "completed",
    content: lastAssistantText || `${toolCalls.length} tool calls without text output.`,
    timestamp: new Date().toISOString(), toolCalls, toolErrors,
    _nonceMatched: nonceMatched,
  };
}