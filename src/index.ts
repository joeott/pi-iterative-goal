/**
 * iterative-goal - Autonomous supervisor loop for Pi Coding Agent.
 *
 * Architecture:
 *   The extension owns a durable four-phase loop (research → plan →
 *   implement → validate/evaluate). It never voluntarily stops until
 *   an external evaluator returns goal_met: true.
 *
 * Key invariants:
 *   - agent_end drives the loop, not the assistant's final text
 *   - sendUserMessage(..., { deliverAs: "followUp" }) enqueues next phase
 *   - All errors are recoverable, evaluator-visible loop events
 *   - Capability preflight prevents hallucinated tool calls
 *   - Safety blocks default-deny destructive operations
 *   - State persists to session + disk for compaction recovery
 */

import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { createStateManager, nextPhase as stateNextPhase, type StateManagerAPI } from "./state.js";
import { takeCapabilitySnapshot, detectSubagentBackend } from "./capabilities.js";
import { classifyError, createErrorRecord, getRecoveryAction } from "./errors.js";
import { registerGoalShellTool } from "./shell.js";
import { registerGoalSubagentTool } from "./subagents.js";
import { renderPhasePrompt, renderResumePrompt, renderCompactionSummary } from "./phases.js";
import { runExternalEvaluator } from "./evaluator.js";
import {
  updateStatusBar,
  updateWidget,
  clearStatusBar,
  registerDashboardCommands,
} from "./dashboard.js";
import { checkCommand } from "./safety.js";
import { type PhaseArtifact, type Phase, PHASE_ORDER, PhaseResultParams } from "./types.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [core] ${msg}\n`);
  } catch {}
}

// ── Main Extension ──────────────────────────────────────────────────

function harnessMetaPrefix(state: { runId: string; cycle: number; phase: string; status: string; evaluator: { lastVerdict?: { goal_met: boolean; confidence: number } } }): string {
  const verdict = state.evaluator.lastVerdict;
  return `[HARNESS_META] runId=${state.runId} cycle=${state.cycle} phase=${state.phase} status=${state.status}${verdict ? ` lastVerdict=${verdict.goal_met}/${verdict.confidence}` : ""}\n\n`;
}

export default function registerIterativeGoalExtension(pi: ExtensionAPI): void {
  log("=== Extension initializing ===");
  const stateManager = createStateManager(pi);

  // ── Register tools ───────────────────────────────────────────────

  registerGoalShellTool(pi);
  registerGoalSubagentTool(pi, () => stateManager.getState()?.capabilities ?? null);

  // goal_report_phase_result - mandatory tool for models to report phase completion
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
          content: [{ type: "text" as const, text: "No active goal. Start one with /goal-start." }],
          details: {},
        };
      }

      const phase = params.phase as Phase;
      const artifact: PhaseArtifact = {
        phase,
        cycle: state.cycle,
        status: (params.status as PhaseArtifact["status"]) ?? "completed",
        content: params.summary ?? "",
        timestamp: new Date().toISOString(),
        toolCalls: [],
        toolErrors: [],
      };

      stateManager.recordArtifact(artifact);
      log(`Phase result recorded: ${phase} cycle=${state.cycle} status=${artifact.status}`);

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

  // goal_record_blocker - for models to report blockers
  pi.registerTool({
    name: "goal_record_blocker",
    label: "Record Blocker",
    description: "Record a blocker that prevents progress on the current phase.",
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
        return { content: [{ type: "text" as const, text: "No active goal." }], details: {} };
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

  // goal_request_capability_repair - for models to request tool/model fixes
  pi.registerTool({
    name: "goal_request_capability_repair",
    label: "Request Capability Repair",
    description: "Request that a missing capability be restored (tool, model, MCP server).",
    parameters: Type.Object({
      what: Type.String({ description: "What is missing (tool name, model, etc.)" }),
      kind: StringEnum(["tool_missing", "model_incompatible", "mcp_server_missing"] as const),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      log(`Capability repair requested: ${params.what} (${params.kind})`);

      if (params.kind === "model_incompatible") {
        const state = stateManager.getState();
        if (state && state.config.fallbackModels.length > 0) {
          const fallback = state.config.fallbackModels[0];
          const model = ctx.modelRegistry.find(fallback.provider, fallback.model);
          if (model) {
            await pi.setModel(model);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Switched to fallback model: ${fallback.provider}/${fallback.model}. Retry the phase.`,
                },
              ],
              details: {},
            };
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

  // goal_checkpoint - manual checkpoint trigger
  pi.registerTool({
    name: "goal_checkpoint",
    label: "Goal Checkpoint",
    description: "Force a state checkpoint to disk and session.",
    parameters: Type.Object({}),
    async execute() {
      stateManager.persistAll();
      return {
        content: [{ type: "text" as const, text: "State checkpoint created." }],
        details: {},
      };
    },
  });

  // ── Core loop motor: agent_end drives the phase transitions ─────

  pi.on("agent_end", async (event, ctx) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    log(`agent_end: cycle=${state.cycle}, phase=${state.phase}`);

    // Try to extract phase result from messages if model didn't call goal_report_phase_result
    const lastArtifact = getLastArtifactForPhase(state, state.phase);
    if (!lastArtifact) {
      // Synthesize from assistant output
      const synthesized = synthesizePhaseResult(event, state.phase, state.cycle);
      if (synthesized) {
        stateManager.recordArtifact(synthesized);
        log(`Synthesized ${state.phase} result from model output`);
      }
    }

    // Classify any tool errors from this turn
    classifyTurnErrors(state, event);

    // Phase transition
    if (state.phase === "validate") {
      // Run external evaluator
      log(`Running external evaluator for cycle ${state.cycle}`);
      const verdict = await runExternalEvaluator(pi, state, ctx);
      stateManager.recordVerdict(verdict);

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      if (verdict.goal_met === true) {
        stateManager.markSucceeded();
        updateStatusBar(ctx, state);
        updateWidget(ctx, state);
        pi.sendMessage(
          {
            customType: "iterative-goal-complete",
            content: `## Goal Complete ✓\n\n**Goal**: ${state.goal}\n**Cycles**: ${state.cycle}\n**Evaluator confidence**: ${verdict.confidence}\n\n${verdict.accepted_evidence.length > 0 ? `Accepted evidence:\n${verdict.accepted_evidence.map(e => `- ${e}`).join("\n")}` : ""}`,
            display: true,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify("Iterative goal completed by external evaluator.");
        log(`GOAL MET after ${state.cycle} cycles`);
        return;
      }

      // External-blocked completion: all harness work done, external blockers remain
      if (verdict.next_cycle_directive.focus === "external_blocked_complete") {
        stateManager.markCompletedBlocked();
        updateStatusBar(ctx, state);
        updateWidget(ctx, state);
        pi.sendMessage(
          {
            customType: "iterative-goal-completed-blocked",
            content: `## Harness Work Complete — External Blockers Remain\n\n**Goal**: ${state.goal}\n**Cycles**: ${state.cycle}\n**Evaluator confidence**: ${verdict.confidence}\n\n**External Blockers**:\n${verdict.completion_blockers.map(b => `- ${b}`).join("\n")}\n\n**Accepted Evidence**:\n${verdict.accepted_evidence.map(e => `- ${e}`).join("\n")}\n\nAll in-harness implementation and validation is complete. Resolve external blockers manually.`,
            display: true,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify("Iterative goal: harness work complete. External blockers remain.");
        log(`COMPLETED_EXTERNAL_BLOCKERS after ${state.cycle} cycles. Blockers: ${verdict.completion_blockers.join("; ")}`);
        return;
      }

      // goal_met=false → next cycle
      stateManager.incrementCycle();
      stateManager.setPhase("research");
      stateManager.persistAll();

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      // Handle capability repair directive
      const nextPhase: Phase =
        verdict.next_cycle_directive.focus === "capability_repair"
          ? "research"
          : verdict.next_cycle_directive.focus as Phase;

      stateManager.setPhase(nextPhase);

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);

      const prompt = renderPhasePrompt(nextPhase, state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      log(`Next cycle ${state.cycle} starting with ${nextPhase}`);

      return;
    }

    // Not validate → advance to next phase in order
    const nextPhase = stateNextPhase(state.phase);
    stateManager.setPhase(nextPhase);
    stateManager.persistAll();

    updateStatusBar(ctx, state);
    updateWidget(ctx, state);

    const snapshot = takeCapabilitySnapshot(pi);
    stateManager.setCapabilities(snapshot);
    const backends = detectSubagentBackend(pi, snapshot);

    const prompt = renderPhasePrompt(nextPhase, state, snapshot, backends);
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    log(`Phase transition: ${state.phase} → ${nextPhase}`);
  });

  // ── Session lifecycle ────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start: reason=${(_event as any).reason}`);

    const restored = stateManager.restore(ctx);
    if (restored) {
      log(`Restored state: runId=${restored.runId}, cycle=${restored.cycle}, status=${restored.status}`);

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

        const prompt = renderResumePrompt(restored, snapshot, backends);
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

  // ── Compaction recovery ──────────────────────────────────────────

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

  // ── Tool error interception ──────────────────────────────────────

  pi.on("tool_call", async (event) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    // Safety gate: block destructive commands from bash
    if (event.toolName === "bash") {
      const command = event.input?.command as string | undefined;
      if (command) {
        const result = checkCommand(command, state.constraints.allowDestructiveOps, state.constraints.allowGitFinalization ?? false);
        if (!result.allowed) {
          log(`Blocked bash command: ${result.reason}`);
          return {
            block: true,
            reason: result.reason,
          };
        }
      }
    }
  });

  // ── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("goal-start", {
    description: "Start an autonomous iterative goal loop",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /goal-start <goal description>", "warning");
        return;
      }

      // Parse goal and criterion (use #criterion: syntax)
      let goal = trimmed;
      let criterion = "All explicit completion criteria are satisfied, validation passes, and state is reproducible.";

      const criterionMatch = trimmed.match(/#criterion:\s*(.+)/);
      if (criterionMatch) {
        criterion = criterionMatch[1].trim();
        goal = trimmed.replace(criterionMatch[0], "").trim();
      }

      const existing = stateManager.getState();
      if (existing && existing.status === "running") {
        const ok = await ctx.ui.confirm(
          "Replace active goal?",
          `An iterative goal is already running: "${existing.goal}"\n\nStart a new one?`,
        );
        if (!ok) return;
      }

      const state = stateManager.createRun(goal, criterion);
      log(`Goal started: runId=${state.runId}, goal="${goal}"`);

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const backends = detectSubagentBackend(pi, snapshot);
      const prompt = renderPhasePrompt("research", state, snapshot, backends);

      pi.sendUserMessage(prompt);
      ctx.ui.notify(
        `Iterative goal started: cycle ${state.cycle}, phase research`,
      );
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show current iterative-goal status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify("No active iterative goal. Start one with /goal-start.", "info");
        return;
      }

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const s = state;
      const lines = [
        `Iterative Goal Status:`,
        `  Run ID: ${s.runId}`,
        `  Goal: ${s.goal}`,
        `  Criterion: ${s.goalCriterion}`,
        `  Status: ${s.status}`,
        `  Cycle: ${s.cycle}`,
        `  Phase: ${s.phase}`,
        ``,
        `  Artifacts: R:${s.artifacts.research.length} P:${s.artifacts.plans.length} I:${s.artifacts.implementations.length} V:${s.artifacts.validations.length}`,
        `  Errors: ${s.errors.length}`,
      ];

      if (s.evaluator.lastVerdict) {
        const v = s.evaluator.lastVerdict;
        lines.push(
          ``,
          `  Evaluator: goal_met=${v.goal_met}, confidence=${v.confidence}`,
          `  Blockers: ${v.completion_blockers.length}`,
          `  Next focus: ${v.next_cycle_directive.focus}`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("goal-pause", {
    description: "Pause the autonomous iterative goal loop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state || state.status !== "running") {
        ctx.ui.notify("No active iterative goal to pause.", "warning");
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
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state || state.status !== "paused_by_user") {
        ctx.ui.notify("No paused iterative goal to resume.", "warning");
        return;
      }
      stateManager.setStatus("running");
      stateManager.persistAll();

      updateStatusBar(ctx, state);
      updateWidget(ctx, state);

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);

      const prompt = renderResumePrompt(state, snapshot, backends);
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
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify("No active iterative goal.", "info");
        return;
      }

      const snapshot = takeCapabilitySnapshot(pi);
      stateManager.setCapabilities(snapshot);

      const issues: string[] = [];
      if (!snapshot.hasBashTool) issues.push("bash tool unavailable (goal_shell is available)");
      if (!snapshot.hasSubagentTool && !snapshot.hasAgentTool) issues.push("no subagent backend");
      if (snapshot.mcpServers.length === 0) issues.push("no MCP servers detected");

      if (issues.length === 0) {
        ctx.ui.notify("Capabilities look good. All core tools available.");
      } else {
        ctx.ui.notify(
          `Capability issues found:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
          "warning",
        );
      }

      // Attempt model fallback if provider issues
      if (state.config.fallbackModels.length > 0) {
        for (const fb of state.config.fallbackModels) {
          const model = ctx.modelRegistry.find(fb.provider, fb.model);
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

  pi.registerCommand("goal-reset", {
    description: "Reset the iterative-goal state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) {
        ctx.ui.notify("No active iterative goal to reset.", "info");
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

  // ── Dashboard command ────────────────────────────────────────────

  registerDashboardCommands(pi, stateManager);
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

function synthesizePhaseResult(
  event: any,
  phase: Phase,
  cycle: number,
): PhaseArtifact | null {
  const messages = event.messages;
  if (!messages || messages.length === 0) return null;

  // Find last assistant message
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
        error: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content).slice(0, 500),
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
    content: lastAssistantText || `${toolCalls.length} tool calls without text output.`,
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
        log(`Error classified: ${kind} from "${errorText.slice(0, 100)}"`);
        const errorRecord = createErrorRecord(errorText, state.phase, state.cycle);
        // State is already referenced from closure
      }
    }
  }
}
