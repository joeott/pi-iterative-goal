import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createErrorRecord } from "../errors.js";
import { findFirstHealthyFallback } from "../kernel/workflow-engine.js";
import { type StateManagerAPI } from "../state.js";
import {
  type IterativeGoalState,
  type Phase,
  type PhaseArtifact,
  PHASE_ORDER,
  PhaseResultParams,
} from "../types.js";

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

function rejectStale(
  stateManager: StateManagerAPI,
  state: IterativeGoalState | null,
  reason: string,
  params: { runId?: string; phaseAttemptId?: string },
): string {
  if (!state) return `STALE OUTPUT REJECTED: ${reason}. No active run exists.`;

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

export function registerGoalCoreTools(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
  options: { log?: (message: string) => void } = {},
): void {
  pi.registerTool({
    name: "goal_report_phase_result",
    label: "Report Phase Result",
    description: "MANDATORY: Call at end of each phase. Must include runId and phaseAttemptId from the phase prompt's [HARNESS_META] block.",
    promptSnippet: "Report completion of an iterative-goal phase",
    promptGuidelines: [
      "ALWAYS call goal_report_phase_result at end of every phase. Include runId and phaseAttemptId from the [HARNESS_META] block in the phase prompt. Without these, the call is rejected as stale.",
    ],
    parameters: PhaseResultParams,

    async execute(_toolCallId, params) {
      const state = stateManager.getState();
      const rejectReason = checkStaleWriteGuard(state, params as any, "goal_report_phase_result");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state, rejectReason, params as any) }],
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
        synthesis: { source: "tool_report", nonceMatched: true },
      };

      stateManager.recordArtifact(artifact);
      stateManager.recordPhaseEvent({
        runId: s.runId, cycle: s.cycle, phase,
        phaseAttemptId: params.phaseAttemptId as string,
        attempt: s.phaseAttempts.filter(a => a.cycle === s.cycle && a.phase === phase).length + 1,
        kind: "phase_result_committed", timestamp: new Date().toISOString(),
        details: { status: artifact.status },
      });

      options.log?.(`Phase result recorded: ${phase} cycle=${s.cycle} status=${artifact.status}`);

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

    async execute(_toolCallId, params) {
      const state = stateManager.getState();
      const rejectReason = checkStaleWriteGuard(state, params as any, "goal_record_blocker");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state, rejectReason, params as any) }],
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

  pi.registerTool({
    name: "goal_request_capability_repair", label: "Request Capability Repair",
    description: "Request that a missing capability be restored.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "MUST match [HARNESS_META] runId if the prompt contains one" })),
      what: Type.String({ description: "What is missing" }),
      kind: StringEnum(["tool_missing", "model_incompatible", "mcp_server_missing"] as const),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      options.log?.(`Capability repair requested: ${params.what} (${params.kind})`);

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

  pi.registerTool({
    name: "goal_checkpoint", label: "Goal Checkpoint",
    description: "Force a state checkpoint.",
    parameters: Type.Object({}),
    async execute() {
      stateManager.persistAll();
      return { content: [{ type: "text" as const, text: "State checkpoint created." }], details: {} };
    },
  });
}
