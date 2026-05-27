/**
 * iterative-goal - Autonomous supervisor loop for Pi Coding Agent.
 *
 * Architecture:
 *   The extension owns a durable four-phase loop (research → plan →
 *   implement → validate/evaluate). It never voluntarily stops until
 *   an external evaluator returns goal_met: true.
 *
 * Key invariants (harness v2):
 *   - agent_end drives the loop, not the assistant's final text
 *   - sendUserMessage(..., { deliverAs: "followUp" }) enqueues next phase
 *   - All errors are recoverable, evaluator-visible loop events
 *   - Capability preflight prevents hallucinated tool calls
 *   - Safety blocks default-deny destructive operations
 *   - Run-scoped artifact directories prevent cycle/file collisions
 *   - Single active-run/phase lock prevents interleaving
 *   - Transactional phase lifecycle with atomic persistence
 *   - Diff-based implementation verification against plan allowlist
 *   - Harness-owned validation scripts
 *   - Explicit evaluator state (not inferred from file existence)
 *   - Clean PR/finalization modes with patch fallback
 *   - Queue cancellation on new goal
 *   - Model provider health caching
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

// ── Helpers ────────────────────────────────────────────────────────

function harnessMetaPrefix(state: {
  runId: string;
  cycle: number;
  phase: string;
  status: string;
  evaluator: { lastVerdict?: { goal_met: boolean; confidence: number } };
}): string {
  const verdict = state.evaluator.lastVerdict;
  return `[HARNESS_META] runId=${state.runId} cycle=${state.cycle} phase=${state.phase} status=${state.status}${verdict ? ` lastVerdict=${verdict.goal_met}/${verdict.confidence}` : ""}\n\n`;
}

function getLastArtifactForPhase(
  state: ReturnType<StateManagerAPI["getState"]>,
  phase: Phase,
): PhaseArtifact | null {
  if (!state) return null;
  switch (phase) {
    case "research":
      return state.artifacts.research.at(-1) ?? null;
    case "plan":
      return state.artifacts.plans.at(-1) ?? null;
    case "implement":
      return state.artifacts.implementations.at(-1) ?? null;
    case "validate":
      return state.artifacts.validations.at(-1) ?? null;
  }
}

function synthesizePhaseResult(
  event: any,
  phase: Phase,
  cycle: number,
): PhaseArtifact | null {
  const messages = event.messages;
  if (!messages || messages.length === 0) return null;

  let lastAssistantText = "";
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolErrors: Array<{ name: string; error: string }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content || []) {
        if (part.type === "text") {
          lastAssistantText = part.text || "";
          break;
        }
        if (part.type === "toolCall") {
          toolCalls.push({ name: part.name, args: part.arguments || {} });
        }
      }
      if (lastAssistantText) break;
    }
    if (msg.role === "toolResult" && msg.isError) {
      toolErrors.push({
        name: msg.toolName || "unknown",
        error:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content).slice(0, 500),
      });
    }
  }

  if (!lastAssistantText && toolCalls.length === 0) {
    return {
      phase,
      cycle,
      status: "failed_recoverable",
      content: `No output detected from model during ${phase} phase. Possible provider/tool incompatibility.`,
      timestamp: new Date().toISOString(),
      toolCalls: [],
      toolErrors,
    };
  }

  return {
    phase,
    cycle,
    status: "completed",
    content:
      lastAssistantText ||
      `${toolCalls.length} tool calls without text output.`,
    timestamp: new Date().toISOString(),
    toolCalls,
    toolErrors,
  };
}

function classifyTurnErrors(state: any, event: any): void {
  if (!state) return;
  const messages = event.messages || [];

  for (const msg of messages) {
    if (msg.role === "toolResult" && msg.isError) {
      const errorText =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);

      const kind = classifyError(errorText);
      if (kind !== "unknown") {
        log(
          `Error classified: ${kind} from "${errorText.slice(0, 100)}"`,
        );
      }
    }
  }
}

// ── Diff verification ────────────────────────────────────────────

async function verifyImplementationAgainstPlan(
  state: ReturnType<StateManagerAPI["getState"]>,
  stateManager: StateManagerAPI,
): Promise<{
  changedFiles: string[];
  diffStat: string;
  allowlistViolation: boolean;
}> {
  if (!state) return { changedFiles: [], diffStat: "", allowlistViolation: false };

  // Capture actual changed files via git
  let changedFiles: string[] = [];
  let diffStat = "";
  try {
    const { execSync } = require("node:child_process");
    changedFiles = execSync("git diff --name-only", { encoding: "utf-8", timeout: 10_000 })
      .trim()
      .split("\n")
      .filter(Boolean);
    diffStat = execSync("git diff --stat", { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    log("git diff failed — cannot verify implementation");
    return { changedFiles: [], diffStat: "", allowlistViolation: false };
  }

  // Write diff patch to the run-scoped directory
  const patchPath = stateManager.getArtifactPath(
    state.cycle,
    "implement",
    "diff.patch",
  );
  try {
    const fs = require("node:fs");
    const { execSync } = require("node:child_process");
    const patch = execSync("git diff", { encoding: "utf-8", timeout: 10_000 });
    fs.writeFileSync(patchPath, patch);
  } catch {}

  log(
    `Implementation verification: ${changedFiles.length} files changed: ${changedFiles.join(", ")}`,
  );

  return {
    changedFiles,
    diffStat,
    allowlistViolation: false, // Checked in evaluator
  };
}

// ── Model health check ───────────────────────────────────────────

async function checkModelHealth(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<ModelHealthEntry> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return {
      model: modelId,
      provider,
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: "Model not found in registry",
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      model: modelId,
      provider,
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: "Auth failed or no API key",
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  // Try a smoke test — produce one token
  try {
    const { complete } = require("@earendil-works/pi-ai") as typeof import("@earendil-works/pi-ai");
    await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Say OK." }],
            timestamp: Date.now(),
          },
        ],
        systemPrompt: "",
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 1,
        signal: AbortSignal.timeout(15_000),
      },
    );
    return {
      model: modelId,
      provider,
      lastStatus: "available",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      cooldownUntil: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Model health check failed for ${provider}/${modelId}: ${msg}`);
    return {
      model: modelId,
      provider,
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: msg,
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
    };
  }
}

// ── Main Extension ──────────────────────────────────────────────────

export default function registerIterativeGoalExtension(pi: ExtensionAPI): void {
  log("=== Extension initializing (v2) ===");
  const stateManager = createStateManager(pi);

  // ── Register tools ───────────────────────────────────────────────

  registerGoalShellTool(pi);
  registerGoalSubagentTool(
    pi,
    () => stateManager.getState()?.capabilities ?? null,
  );

  // goal_report_phase_result
  pi.registerTool({
    name: "goal_report_phase_result",
    label: "Report Phase Result",
    description: [
      "MANDATORY: Call this tool at the end of each iterative-goal phase.",
      "Reports what was accomplished, blockers, and recommendations.",
      "The extension will not continue to the next phase until this is called or",
      "a synthesized report is created.",
    ].join(" "),
    promptSnippet: "Report completion of an iterative-goal phase",
    promptGuidelines: [
      "ALWAYS call goal_report_phase_result at the end of every iterative-goal phase (research, plan, implement, validate). The extension relies on this call to proceed to the next phase.",
    ],
    parameters: PhaseResultParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = stateManager.getState();
      if (!state) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active goal. Start one with /goal-start.",
            },
          ],
          details: {},
        };
      }

      const phase = params.phase as Phase;
      const artifact: PhaseArtifact = {
        phase,
        cycle: state.cycle,
        status:
          (params.status as PhaseArtifact["status"]) ?? "completed",
        content: params.summary ?? "",
        timestamp: new Date().toISOString(),
        toolCalls: [],
        toolErrors: [],
      };

      stateManager.recordArtifact(artifact);
      stateManager.recordPhaseEvent({
        runId: state.runId,
        cycle: state.cycle,
        phase,
        phaseAttemptId: state.lock.activePhaseId ?? "",
        attempt: state.phaseAttempts.filter(
          (a) => a.cycle === state.cycle && a.phase === phase,
        ).length + 1,
        kind: "phase_result_committed",
        timestamp: new Date().toISOString(),
        details: { status: artifact.status },
      });

      log(
        `Phase result recorded: ${phase} cycle=${state.cycle} status=${artifact.status}`,
      );

      // Mark related errors as resolved
      for (const err of state.errors) {
        if (err.phase === phase && err.cycle === state.cycle) {
          err.resolved = true;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Phase '${phase}' result recorded for cycle ${state.cycle}. Status: ${artifact.status}. The extension will proceed automatically.`,
          },
        ],
        details: artifact as unknown as Record<string, unknown>,
      };
    },
  });

  // goal_record_blocker
  pi.registerTool({
    name: "goal_record_blocker",
    label: "Record Blocker",
    description:
      "Record a blocker that prevents progress on the current phase.",
    parameters: Type.Object({
      phase: StringEnum([...PHASE_ORDER] as const),
      title: Type.String(),
      description: Type.String(),
      severity: StringEnum(["critical", "high", "medium", "low"] as const, {
        default: "high",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = stateManager.getState();
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "No active goal." }],
          details: {},
        };
      }

      const error = createErrorRecord(
        `[BLOCKER] ${params.title}: ${params.description}`,
        params.phase as Phase,
        state.cycle,
      );
      stateManager.recordError(error);

      return {
        content: [
          {
            type: "text" as const,
            text: `Blocker recorded: ${params.title} (${params.severity}). The evaluator will review this.`,
          },
        ],
        details: error as unknown as Record<string, unknown>,
      };
    },
  });

  // goal_request_capability_repair
  pi.registerTool({
    name: "goal_request_capability_repair",
    label: "Request Capability Repair",
    description:
      "Request that a missing capability be restored (tool, model, MCP server).",
    parameters: Type.Object({
      what: Type.String({
        description: "What is missing (tool name, model, etc.)",
      }),
      kind: StringEnum([
        "tool_missing",
        "model_incompatible",
        "mcp_server_missing",
      ] as const),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      log(
        `Capability repair requested: ${params.what} (${params.kind})`,
      );

      if (params.kind === "model_incompatible") {
        const state = stateManager.getState();
        if (state && state.config.fallbackModels.length > 0) {
          for (const fb of state.config.fallbackModels) {
            // Check model health cache before trying
            const key = `${fb.provider}/${fb.model}`;
            const health = state.config.modelHealth[key];
            if (health?.lastStatus === "unavailable" && health.cooldownUntil) {
              if (new Date(health.cooldownUntil) > new Date()) {
                log(`Skipping ${key} — in cooldown`);
                continue;
              }
            }

            const model = ctx.modelRegistry.find(fb.provider, fb.model);
            if (model) {
              await pi.setModel(model);

              // Record fallback in phase attempt
              const currentAttempt = state.phaseAttempts.at(-1);
              if (currentAttempt) {
                currentAttempt.fallbackChain.push({
                  provider: fb.provider,
                  model: fb.model,
                  reason: "model_incompatible",
                });
              }

              stateManager.recordPhaseEvent({
                runId: state.runId,
                cycle: state.cycle,
                phase: state.phase,
                phaseAttemptId: currentAttempt?.phaseAttemptId ?? "",
                attempt: currentAttempt?.attempt ?? 1,
                kind: "model_fallback",
                timestamp: new Date().toISOString(),
                details: {
                  from: `${state.config.primaryModel.provider}/${state.config.primaryModel.model}`,
                  to: `${fb.provider}/${fb.model}`,
                  reason: "model_incompatible",
                },
              });

              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Switched to fallback model: ${fb.provider}/${fb.model}. Retry the phase.`,
                  },
                ],
                details: {},
              };
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Capability repair for '${params.what}' (${params.kind}) recorded. Will be addressed after evaluation.`,
          },
        ],
        details: {},
      };
    },
  });

  // goal_checkpoint
  pi.registerTool({
    name: "goal_checkpoint",
    label: "Goal Checkpoint",
    description: "Force a state checkpoint to disk and session.",
    parameters: Type.Object({}),
    async execute() {
      stateManager.persistAll();
      return {
        content: [
          { type: "text" as const, text: "State checkpoint created." },
        ],
        details: {},
      };
    },
  });

  // ── Core loop motor ────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    log(
      `agent_end: runId=${state.runId} cycle=${state.cycle} phase=${state.phase}`,
    );

    // Verify this run owns the lock
    if (state.lock.activeRunId !== state.runId) {
      log("agent_end: run does not own lock — skipping");
      return;
    }

    // Record phase events lifecycle
    const phaseAttemptId = state.lock.activePhaseId || "";
    stateManager.recordPhaseEvent({
      runId: state.runId,
      cycle: state.cycle,
      phase: state.phase,
      phaseAttemptId,
      attempt: state.phaseAttempts.filter(
        (a) =>
          a.cycle === state.cycle && a.phase === state.phase,
      ).length + 1,
      kind: "phase_output_received",
      timestamp: new Date().toISOString(),
    });

    // Try to extract/synthesize phase result
    const lastArtifact = getLastArtifactForPhase(state, state.phase);
    if (!lastArtifact) {
      const synthesized = synthesizePhaseResult(
        event,
        state.phase,
        state.cycle,
      );
      if (synthesized) {
        stateManager.recordArtifact(synthesized);
        stateManager.recordPhaseEvent({
          runId: state.runId,
          cycle: state.cycle,
          phase: state.phase,
          phaseAttemptId,
          attempt: state.phaseAttempts.filter(
            (a) => a.cycle === state.cycle && a.phase === state.phase,
          ).length + 1,
          kind: "phase_result_parsed",
          timestamp: new Date().toISOString(),
          details: { synthesized: true },
        });
        log(`Synthesized ${state.phase} result from model output`);
      }
    }

    // Classify any tool errors
    classifyTurnErrors(state, event);

    // Implement-phase specific: verify diffs
    if (state.phase === "implement") {
      const diffInfo = await verifyImplementationAgainstPlan(
        state,
        stateManager,
      );
      log(
        `Implement verify: ${diffInfo.changedFiles.length} files changed`,
      );
      stateManager.recordPhaseEvent({
        runId: state.runId,
        cycle: state.cycle,
        phase: state.phase,
        phaseAttemptId,
        attempt: state.phaseAttempts.length,
        kind: "phase_artifacts_persisted",
        timestamp: new Date().toISOString(),
        details: { changedFiles: diffInfo.changedFiles },
      });
    }

    // Persist
    stateManager.recordPhaseEvent({
      runId: state.runId,
      cycle: state.cycle,
      phase: state.phase,
      phaseAttemptId,
      attempt: state.phaseAttempts.length,
      kind: "phase_result_committed",
      timestamp: new Date().toISOString(),
    });
    stateManager.persistAll();

    // Phase transition
    if (state.phase === "validate") {
      // ── Evaluator ────────────────────────────────────────────────
      log(`Running external evaluator for cycle ${state.cycle}`);

      stateManager.recordPhaseEvent({
        runId: state.runId,
        cycle: state.cycle,
        phase: state.phase,
        phaseAttemptId,
        attempt: state.phaseAttempts.length,
        kind: "evaluator_queued",
        timestamp: new Date().toISOString(),
      });

      const verdict = await runExternalEvaluator(
        pi,
        state,
        ctx,
        stateManager,
      );
      stateManager.recordVerdict(verdict);

      stateManager.recordPhaseEvent({
        runId: state.runId,
        cycle: state.cycle,
        phase: state.phase,
        phaseAttemptId,
        attempt: state.phaseAttempts.length,
        kind: "evaluator_verdict_recorded",
        timestamp: new Date().toISOString(),
        details: {
          goal_met: verdict.goal_met,
          confidence: verdict.confidence,
        },
      });

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      if (verdict.goal_met === true) {
        stateManager.markSucceeded();
        stateManager.releaseLock(state.runId, phaseAttemptId);
        updateStatusBar(ctx, state);
        updateWidget(ctx, state);
        pi.sendMessage(
          {
            customType: "iterative-goal-complete",
            content: [
              `## Goal Complete ✓`,
              ``,
              `**Goal**: ${state.goal}`,
              `**Cycles**: ${state.cycle}`,
              `**Evaluator confidence**: ${verdict.confidence}`,
              ``,
              verdict.accepted_evidence.length > 0
                ? `**Accepted evidence**:\n${verdict.accepted_evidence.map((e) => `- ${e}`).join("\n")}`
                : "",
            ].join("\n"),
            display: true,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(
          "Iterative goal completed by external evaluator.",
        );
        log(`GOAL MET after ${state.cycle} cycles`);
        return;
      }

      // External-blocked completion
      if (
        verdict.next_cycle_directive.focus ===
        "external_blocked_complete"
      ) {
        stateManager.markCompletedBlocked();
        stateManager.releaseLock(state.runId, phaseAttemptId);
        updateStatusBar(ctx, state);
        updateWidget(ctx, state);

        // Generate patch if needed
        const patchPath = stateManager.getArtifactPath(
          state.cycle,
          "validate",
          "final.patch",
        );
        try {
          const { execSync } = require("node:child_process");
          const patch = execSync("git diff", {
            encoding: "utf-8",
            timeout: 10_000,
          });
          const fs = require("node:fs");
          fs.writeFileSync(patchPath, patch);
        } catch {}

        pi.sendMessage(
          {
            customType: "iterative-goal-completed-blocked",
            content: [
              `## Harness Work Complete — External Blockers Remain`,
              ``,
              `**Goal**: ${state.goal}`,
              `**Cycles**: ${state.cycle}`,
              `**Evaluator confidence**: ${verdict.confidence}`,
              ``,
              `**External Blockers**:`,
              ...verdict.completion_blockers.map(
                (b) => `- ${b}`,
              ),
              ``,
              `**Accepted Evidence**:`,
              ...verdict.accepted_evidence.map(
                (e) => `- ${e}`,
              ),
              ``,
              `All in-harness implementation and validation is complete.`,
              `Patch available at: ${patchPath}`,
              `Resolve external blockers manually.`,
            ].join("\n"),
            display: true,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(
          "Iterative goal: harness work complete. External blockers remain.",
        );
        log(
          `COMPLETED_EXTERNAL_BLOCKERS after ${state.cycle} cycles. Blockers: ${verdict.completion_blockers.join("; ")}`,
        );
        return;
      }

      // goal_met=false → next cycle
      stateManager.incrementCycle();
      stateManager.setPhase("research");
      stateManager.persistAll();

      stateManager.recordPhaseEvent({
        runId: state.runId,
        cycle: state.cycle,
        phase: "research",
        phaseAttemptId,
        attempt: 1,
        kind: "transition_decided",
        timestamp: new Date().toISOString(),
        details: { from: "validate", reason: "goal_met=false" },
      });

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      // Handle capability repair directive
      const nextPhase: Phase =
        verdict.next_cycle_directive.focus === "capability_repair"
          ? "research"
          : (verdict.next_cycle_directive.focus as Phase);

      stateManager.setPhase(nextPhase);

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);

      // Start phase attempt
      startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi);

      const prompt = renderPhasePrompt(
        nextPhase,
        state,
        snapshot,
        backends,
      );
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      log(
        `Next cycle ${state.cycle} starting with ${nextPhase}`,
      );

      return;
    }

    // Not validate → advance to next phase in order
    const nextPhase = stateNextPhase(state.phase);
    stateManager.setPhase(nextPhase);
    stateManager.persistAll();

    stateManager.recordPhaseEvent({
      runId: state.runId,
      cycle: state.cycle,
      phase: nextPhase,
      phaseAttemptId,
      attempt: 1,
      kind: "next_phase_started",
      timestamp: new Date().toISOString(),
      details: { from: state.phase },
    });

    updateStatusBar(ctx, state);
    updateWidget(ctx, state);

    const snapshot = takeCapabilitySnapshot(pi);
    stateManager.setCapabilities(snapshot);
    const backends = detectSubagentBackend(pi, snapshot);

    // Start phase attempt
    startPhaseAttempt(state, stateManager, nextPhase, snapshot, pi);

    const prompt = renderPhasePrompt(
      nextPhase,
      state,
      snapshot,
      backends,
    );
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    log(`Phase transition: ${state.phase} → ${nextPhase}`);
  });

  // ── Session lifecycle ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start: reason=${(_event as any).reason}`);

    const restored = stateManager.restore(ctx);
    if (restored) {
      log(
        `Restored state: runId=${restored.runId}, cycle=${restored.cycle}, status=${restored.status}`,
      );

      updateStatusBar(ctx, restored);
      updateWidget(ctx, restored);

      // Resume if running
      if (restored.status === "running") {
        ctx.ui.notify(
          `Resuming iterative goal: cycle ${restored.cycle}, phase ${restored.phase}`,
          "info",
        );

        const snapshot = takeCapabilitySnapshot(pi);
        stateManager.setCapabilities(snapshot);
        const backends = detectSubagentBackend(pi, snapshot);

        startPhaseAttempt(restored, stateManager, restored.phase, snapshot, pi);

        const prompt = renderResumePrompt(
          restored,
          snapshot,
          backends,
        );
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    }
  });

  pi.on("session_shutdown", async () => {
    const state = stateManager.getState();
    if (state) {
      stateManager.persistAll();
      log("Shutdown: state persisted");
    }
  });

  // ── Compaction recovery ────────────────────────────────────────

  pi.on("session_before_compact", async (event, ctx) => {
    const state = stateManager.getState();
    if (!state) return;

    const summary = renderCompactionSummary(state);
    stateManager.persistAll();

    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  // ── Tool error interception ────────────────────────────────────

  pi.on("tool_call", async (event) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    if (event.toolName === "bash") {
      const command = event.input?.command as string | undefined;
      if (command) {
        const result = checkCommand(
          command,
          state.constraints.allowDestructiveOps,
          state.finalizationPolicy.allowGitFinalization,
        );
        if (!result.allowed) {
          log(`Blocked bash command: ${result.reason}`);

          // If git finalization blocked, suggest patch
          let suggestion = "";
          if (
            command.match(/\bgit\s+(add|commit)\b/) &&
            !state.finalizationPolicy.allowGitFinalization
          ) {
            const patchPath = stateManager.getArtifactPath(
              state.cycle,
              state.phase,
              "diff.patch",
            );
            suggestion = `\n\nGit finalization is disabled for this run. Use: git diff > ${patchPath}`;
          }

          return {
            block: true,
            reason: (result.reason ?? "") + suggestion,
          };
        }
      }
    }
  });

  // ── Commands ───────────────────────────────────────────────────

  pi.registerCommand("goal-start", {
    description: "Start an autonomous iterative goal loop",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /goal-start <goal description> [#criterion: <criteria>]",
          "warning",
        );
        return;
      }

      let goal = trimmed;
      let criterion =
        "All explicit completion criteria are satisfied, validation passes, and state is reproducible.";

      const criterionMatch = trimmed.match(/#criterion:\s*(.+)/);
      if (criterionMatch) {
        criterion = criterionMatch[1].trim();
        goal = trimmed.replace(criterionMatch[0], "").trim();
      }

      const existing = stateManager.getState();
      if (existing && existing.status === "running") {
        const ok = await ctx.ui.confirm(
          "Replace active goal?",
          `An iterative goal is already running: "${existing.goal}"\n\nStart a new one? Old queued phases will be cancelled.`,
        );
        if (!ok) return;

        // Cancel queued phases for old run
        stateManager.cancelQueuedPhases(existing.runId);
      }

      // Preflight model health
      const modelRegistry = (ctx as any).modelRegistry;
      let modelHealth: Record<string, ModelHealthEntry> = {};
      if (modelRegistry) {
        try {
          const model = modelRegistry.find("openrouter", "deepseek/deepseek-v4-pro");
          if (model) {
            const health = await checkModelHealth(ctx, "openrouter", "deepseek/deepseek-v4-pro");
            modelHealth["openrouter/deepseek/deepseek-v4-pro"] = health;
            log(`Model preflight: ${health.lastStatus}`);
          }
        } catch {}
      }

      const state = stateManager.createRun(goal, criterion, {
        modelHealth,
      });
      log(
        `Goal started: runId=${state.runId}, goal="${goal}"`,
      );

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const backends = detectSubagentBackend(pi, snapshot);
      startPhaseAttempt(state, stateManager, "research", snapshot, pi);

      // Acquire run lock
      stateManager.acquireLock(state.runId, "");
      state.lock.queuedPhaseIds = []; // Clear old queued messages

      const prompt = renderPhasePrompt(
        "research",
        state,
        snapshot,
        backends,
      );
      pi.sendUserMessage(prompt);
      ctx.ui.notify(
        `Iterative goal started: cycle ${state.cycle}, phase research`,
      );
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show current iterative-goal status (--json for machine output)",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const state = stateManager.getState();
      if (!state) {
        if (args.includes("--json")) {
          ctx.ui.notify(
            JSON.stringify({ active: false }, null, 2),
            "info",
          );
        } else {
          ctx.ui.notify(
            "No active iterative goal. Start one with /goal-start.",
            "info",
          );
        }
        return;
      }

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      // JSON mode
      if (args.includes("--json")) {
        const json = {
          active: true,
          runId: state.runId,
          goal: state.goal,
          goalCriterion: state.goalCriterion,
          status: state.status,
          cycle: state.cycle,
          phase: state.phase,
          lock: state.lock,
          evaluator: {
            model: `${state.evaluator.provider}/${state.evaluator.model}`,
            lastVerdict: state.evaluator.lastVerdict
              ? {
                  goal_met: state.evaluator.lastVerdict.goal_met,
                  confidence: state.evaluator.lastVerdict.confidence,
                  blockers: state.evaluator.lastVerdict.completion_blockers,
                  next_focus:
                    state.evaluator.lastVerdict.next_cycle_directive.focus,
                }
              : null,
            state: state.evaluatorState,
          },
          artifacts: {
            research: state.artifacts.research.length,
            plans: state.artifacts.plans.length,
            implementations: state.artifacts.implementations.length,
            validations: state.artifacts.validations.length,
            evaluatorReports:
              state.artifacts.evaluatorReports.length,
          },
          errors: state.errors.length,
          unresolvedErrors: state.errors
            .filter((e) => !e.resolved)
            .map((e) => ({
              phase: e.phase,
              kind: e.kind,
              cycle: e.cycle,
              recoveryAction: e.recoveryAction,
            })),
          modelHealth: state.config.modelHealth,
          finalizationPolicy: state.finalizationPolicy,
          phaseAttempts: state.phaseAttempts.slice(-5).map((a) => ({
            phaseAttemptId: a.phaseAttemptId,
            cycle: a.cycle,
            phase: a.phase,
            attempt: a.attempt,
            status: a.status,
            model: `${a.modelProvider}/${a.modelModel}`,
            fallbackChain: a.fallbackChain,
          })),
        };
        ctx.ui.notify(JSON.stringify(json, null, 2), "info");
        return;
      }

      const s = state;
      const lines = [
        `Iterative Goal Status:`,
        `  Run ID: ${s.runId}`,
        `  Goal: ${s.goal}`,
        `  Criterion: ${s.goalCriterion}`,
        `  Status: ${s.status}`,
        `  Cycle: ${s.cycle}`,
        `  Phase: ${s.phase}`,
        `  Lock: ${s.lock.phaseStatus} (owner: ${s.lock.activePhaseId || "none"})`,
        ``,
        `  Artifacts: R:${s.artifacts.research.length} P:${s.artifacts.plans.length} I:${s.artifacts.implementations.length} V:${s.artifacts.validations.length}`,
        `  Errors: ${s.errors.length}`,
      ];

      if (s.evaluatorState) {
        lines.push(
          ``,
          `  Evaluator: status=${s.evaluatorState.status}`,
          `  Last heartbeat: ${s.evaluatorState.lastHeartbeatAt ?? "never"}`,
          s.evaluatorState.error
            ? `  Evaluator error: ${s.evaluatorState.error}`
            : "",
        );
      }

      if (s.evaluator.lastVerdict) {
        const v = s.evaluator.lastVerdict;
        lines.push(
          ``,
          `  Last Verdict: goal_met=${v.goal_met}, confidence=${v.confidence}`,
          `  Blockers: ${v.completion_blockers.length}`,
          `  Next focus: ${v.next_cycle_directive.focus}`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("goal-pause", {
    description: "Pause the autonomous iterative goal loop",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const state = stateManager.getState();
      if (!state || state.status !== "running") {
        ctx.ui.notify(
          "No active iterative goal to pause.",
          "warning",
        );
        return;
      }
      stateManager.setStatus("paused_by_user");
      updateStatusBar(ctx, state);
      updateWidget(ctx, state);
      ctx.ui.notify(
        `Goal paused at cycle ${state.cycle}, phase ${state.phase}. Use /goal-resume to continue.`,
        "info",
      );
      log("Paused by user");
    },
  });

  pi.registerCommand("goal-resume", {
    description: "Resume a paused iterative goal loop",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const state = stateManager.getState();
      if (!state || state.status !== "paused_by_user") {
        ctx.ui.notify(
          "No paused iterative goal to resume.",
          "warning",
        );
        return;
      }
      stateManager.setStatus("running");
      stateManager.persistAll();

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);

      startPhaseAttempt(state, stateManager, state.phase, snapshot, pi);

      const prompt = renderResumePrompt(
        state,
        snapshot,
        backends,
      );
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });

      ctx.ui.notify(
        `Resuming: cycle ${state.cycle}, phase ${state.phase}`,
        "info",
      );
      log("Resumed by user");
    },
  });

  pi.registerCommand("goal-repair-capabilities", {
    description: "Run capability preflight and attempt fixes",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify("No active iterative goal.", "info");
        return;
      }

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);

      const issues: string[] = [];
      if (!snapshot.hasBashTool)
        issues.push(
          "bash tool unavailable (goal_shell is available)",
        );
      if (!snapshot.hasSubagentTool && !snapshot.hasAgentTool)
        issues.push("no subagent backend");

      if (issues.length === 0) {
        ctx.ui.notify(
          "Capabilities look good. All core tools available.",
        );
      } else {
        ctx.ui.notify(
          `Capability issues found:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
          "warning",
        );
      }

      // Attempt model fallback with health checks
      for (const fb of state.config.fallbackModels) {
        const health = await checkModelHealth(
          ctx,
          fb.provider,
          fb.model,
        );
        state.config.modelHealth[
          `${fb.provider}/${fb.model}`
        ] = health;

        if (health.lastStatus === "available") {
          const model = ctx.modelRegistry.find(
            fb.provider,
            fb.model,
          );
          if (model) {
            await pi.setModel(model);
            ctx.ui.notify(
              `Switched to fallback model: ${fb.provider}/${fb.model}`,
              "info",
            );
            break;
          }
        }
      }

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);
    },
  });

  // goal-finalize — PR/patch finalization
  pi.registerCommand("goal-finalize", {
    description:
      "Finalize the current goal: generate patch or commit. Use --mode patch|isolated-worktree.",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify("No active iterative goal.", "info");
        return;
      }

      const fp = state.finalizationPolicy;

      // Always fall back to patch when git is disabled
      if (!fp.allowGitFinalization && !fp.allowCommit) {
        ctx.ui.notify(
          [
            "Git finalization is disabled for this run.",
            `Patch fallback: creating diff.patch in ${stateManager.getRunDir()}`,
            "",
            "To enable git finalization, update finalizationPolicy in state.",
          ].join("\n"),
          "info",
        );

        const patchPath = stateManager.getArtifactPath(
          state.cycle,
          state.phase,
          "final.patch",
        );
        try {
          const { execSync } = require("node:child_process");
          const patch = execSync("git diff", {
            encoding: "utf-8",
            timeout: 10_000,
          });
          const fs = require("node:fs");
          fs.writeFileSync(patchPath, patch);
          ctx.ui.notify(
            `Patch written to: ${patchPath}`,
            "info",
          );
        } catch (err: any) {
          ctx.ui.notify(
            `Failed to generate patch: ${err.message}`,
            "error",
          );
        }
        return;
      }

      // Isolated worktree mode
      if (args.includes("--mode isolated-worktree")) {
        ctx.ui.notify(
          "Isolated worktree finalization not yet implemented. Use patch mode.",
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        "Use /goal-finalize without flags for patch output.",
        "info",
      );
    },
  });

  pi.registerCommand("goal-reset", {
    description: "Reset the iterative-goal state",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify(
          "No active iterative goal to reset.",
          "info",
        );
        return;
      }

      const ok = await ctx.ui.confirm(
        "Reset iterative goal?",
        `This will clear the current goal "${state.goal}" and all its artifacts. Continue?`,
      );
      if (!ok) return;

      stateManager.clear();
      clearStatusBar(ctx);
      ctx.ui.notify("Iterative goal reset.", "info");
      log("Reset by user");
    },
  });

  // ── Dashboard ──────────────────────────────────────────────────

  registerDashboardCommands(pi, stateManager);
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

  // Check model health for primary
  const primaryKey = `${state.config.primaryModel.provider}/${state.config.primaryModel.model}`;
  const health = state.config.modelHealth[primaryKey];
  if (health?.lastStatus === "unavailable" && health.cooldownUntil) {
    if (new Date(health.cooldownUntil) > new Date()) {
      log(`Primary model ${primaryKey} in cooldown — trying fallbacks`);
    }
  }

  const attempt: PhaseAttempt = {
    runId: state.runId,
    cycle: state.cycle,
    phase,
    attempt: attemptNum,
    phaseAttemptId,
    modelProvider: state.config.primaryModel.provider,
    modelModel: state.config.primaryModel.model,
    fallbackChain: [],
    startedAt: new Date().toISOString(),
    status: "running",
    outputReceived: false,
    resultParsed: false,
    artifactsPersisted: false,
    resultCommitted: false,
  };

  stateManager.startPhaseAttempt(attempt);
  stateManager.acquireLock(state.runId, phaseAttemptId);

  stateManager.recordPhaseEvent({
    runId: state.runId,
    cycle: state.cycle,
    phase,
    phaseAttemptId,
    attempt: attemptNum,
    kind: "phase_started",
    timestamp: new Date().toISOString(),
    details: {
      model: `${state.config.primaryModel.provider}/${state.config.primaryModel.model}`,
    },
  });

  stateManager.recordPhaseEvent({
    runId: state.runId,
    cycle: state.cycle,
    phase,
    phaseAttemptId,
    attempt: attemptNum,
    kind: "tool_preflight_recorded",
    timestamp: new Date().toISOString(),
    details: {
      activeTools: snapshot?.activeTools ?? [],
    },
  });
}