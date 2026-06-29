import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import { createErrorRecord } from "../errors.js";
import { findFirstHealthyFallback } from "../kernel/workflow-engine.js";
import { type StateManagerAPI } from "../state.js";
import {
  type IterativeGoalState,
  type Phase,
  type PhaseArtifact,
  type TaskPlanItem,
  type TaskPlanItemStatus,
  PHASE_ORDER,
  PhaseResultParams,
} from "../types.js";
import { processModelVisibleText } from "../cyber-runtime.js";

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
  function scrubPhaseSummary(state: IterativeGoalState, summary: string, source: string): { text: string; dlpScanId: string | undefined } {
    const processed = processModelVisibleText({
      text: summary,
      source,
      classification: "untrusted_data_plane",
      dlp: state.dlp,
      sanitizer: state.sanitizer,
    });
    stateManager.updateDlpState(processed.dlp);
    stateManager.updateSanitizationState(processed.sanitizer);
    return { text: processed.text, dlpScanId: processed.dlpSummary.scanId };
  }

  function recordPhaseResult(params: Record<string, unknown>, toolName: string) {
    const state = stateManager.getState();
    const rejectReason = checkStaleWriteGuard(state, params as any, toolName);
    if (rejectReason) {
      return {
        content: [{ type: "text" as const,
          text: rejectStale(stateManager, state, rejectReason, params as any) }],
        details: { rejected: true, reason: rejectReason },
      };
    }

    const s = state!;
    const phase = params.phase as Phase;
    const scrubbed = scrubPhaseSummary(s, String(params.summary ?? ""), toolName);
    const artifact: PhaseArtifact = {
      phase, cycle: s.cycle,
      status: (params.status as PhaseArtifact["status"]) ?? "completed",
      content: scrubbed.text,
      timestamp: new Date().toISOString(),
      toolCalls: [], toolErrors: [],
      synthesis: { source: "tool_report", nonceMatched: true },
      dlpScanId: scrubbed.dlpScanId,
      trustClassification: "untrusted_data_plane",
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
  }

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
      return recordPhaseResult(params as unknown as Record<string, unknown>, "goal_report_phase_result");
    },
  });

  pi.registerTool({
    name: "cyber_report_phase_result",
    label: "Cyber Report Phase Result",
    description: "MANDATORY cyber alias for reporting phase results after DLP/IPI processing. Completion remains evaluator-only.",
    promptSnippet: "Report completion of a cyber iterative-goal phase",
    promptGuidelines: [
      "Use cyber_report_phase_result at the end of every cyber phase. Include runId and phaseAttemptId from [HARNESS_META]. Do not include goal_met.",
    ],
    parameters: PhaseResultParams,
    async execute(_toolCallId, params) {
      return recordPhaseResult(params as unknown as Record<string, unknown>, "cyber_report_phase_result");
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
    name: "cyber_record_blocker", label: "Cyber Record Blocker",
    description: "Record a cyber blocker with type and severity. Must include runId and phaseAttemptId from [HARNESS_META].",
    parameters: Type.Object({
      runId: Type.String({ description: "MUST match [HARNESS_META] runId" }),
      phaseAttemptId: Type.String({ description: "MUST match [HARNESS_META] phaseAttemptId" }),
      phase: StringEnum([...PHASE_ORDER] as const),
      blocker_type: StringEnum([
        "missing_authorization",
        "unsafe_request",
        "missing_capability",
        "missing_evidence",
        "external_dependency",
        "dirty_worktree",
        "failed_validation",
        "credential_or_permission",
        "policy_denied",
        "pending_approval",
        "dlp_secret_detected",
        "ipi_detected",
        "sandbox_violation",
        "attestation_missing",
        "wrong_aws_account",
        "stale_or_deprecated_guidance",
      ] as const),
      severity: StringEnum(["critical", "high", "medium", "low"] as const),
      description: Type.String(),
      recommended_resolution: Type.String(),
    }),

    async execute(_toolCallId, params) {
      const state = stateManager.getState();
      const rejectReason = checkStaleWriteGuard(state, params as any, "cyber_record_blocker");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state, rejectReason, params as any) }],
          details: { rejected: true, reason: rejectReason },
        };
      }
      const error = createErrorRecord(
        `[${params.blocker_type}] ${params.description} Resolution: ${params.recommended_resolution}`,
        params.phase as Phase, state!.cycle,
      );
      error.kind = params.blocker_type as any;
      stateManager.recordError(error);
      return {
        content: [{ type: "text" as const, text: `Cyber blocker recorded: ${params.blocker_type} (${params.severity}).` }],
        details: error as unknown as Record<string, unknown>,
      };
    },
  });

  pi.registerTool({
    name: "cyber_request_approval",
    label: "Cyber Request Approval",
    description: "Suspend the run and request explicit operator approval for a dangerous or production-impacting action.",
    parameters: Type.Object({
      requested_action: Type.String(),
      blast_radius_assessment: Type.String(),
      justification: Type.String(),
      rollback_plan: Type.String(),
      expires_at: Type.Optional(Type.String()),
      affected_resources: Type.Optional(Type.Array(Type.String())),
      exact_commands: Type.Optional(Type.Array(Type.String())),
      exact_aws_actions: Type.Optional(Type.Array(Type.String())),
      data_access_scope: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const state = stateManager.getState();
      if (!state) {
        return { content: [{ type: "text" as const, text: "No active run; approval request ignored." }], details: { rejected: true } };
      }
      const token = `APPROVAL_${state.runId}_${state.cycle}_${crypto.randomBytes(4).toString("hex")}`;
      const request = {
        token,
        requestedAction: String(params.requested_action),
        blastRadiusAssessment: String(params.blast_radius_assessment),
        justification: String(params.justification),
        rollbackPlan: String(params.rollback_plan),
        affectedResources: (params.affected_resources as string[] | undefined) ?? [],
        exactCommands: (params.exact_commands as string[] | undefined) ?? [],
        exactAwsActions: (params.exact_aws_actions as string[] | undefined) ?? [],
        dataAccessScope: typeof params.data_access_scope === "string" ? params.data_access_scope : null,
        requestedAt: new Date().toISOString(),
        expiresAt: typeof params.expires_at === "string" ? params.expires_at : null,
        status: "pending" as const,
        resolvedAt: null,
      };
      stateManager.requestApproval(request);
      return {
        content: [{ type: "text" as const, text: `Approval requested and run suspended. Token: ${token}` }],
        details: { rejected: false, ...request },
      };
    },
  });

  pi.registerTool({
    name: "goal_update_task_plan",
    label: "Update Task Plan",
    description: "Replace the durable task checklist for the active run. Use for multi-step coding coordination and compaction recovery.",
    promptSnippet: "Maintain a durable task checklist for the current goal",
    promptGuidelines: [
      "Use goal_update_task_plan when planning or when task status changes. Include runId and phaseAttemptId from [HARNESS_META]. Keep exactly zero or one item in_progress.",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "MUST match [HARNESS_META] runId" }),
      phaseAttemptId: Type.String({ description: "MUST match [HARNESS_META] phaseAttemptId" }),
      rationale: Type.Optional(Type.String({ description: "Why this task plan changed" })),
      items: Type.Array(Type.Object({
        id: Type.Optional(Type.String({ description: "Stable short id. If omitted, the harness assigns task-N." })),
        title: Type.String(),
        status: StringEnum(["pending", "in_progress", "completed", "blocked", "cancelled"] as const),
        detail: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_toolCallId, params): Promise<any> {
      const state = stateManager.getState();
      const rejectReason = checkStaleWriteGuard(state, params as any, "goal_update_task_plan");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state, rejectReason, params as any) }],
          details: { rejected: true, reason: rejectReason },
        };
      }

      const s = state!;
      const rawItems = Array.isArray(params.items) ? params.items : [];
      const inProgress = rawItems.filter((item: any) => item.status === "in_progress");
      if (inProgress.length > 1) {
        return {
          content: [{ type: "text" as const, text: "TASK PLAN REJECTED: at most one item may be in_progress." }],
          details: { rejected: true, reason: "multiple_in_progress_items" },
        };
      }

      const seenIds = new Set<string>();
      let dlp = s.dlp;
      let sanitizer = s.sanitizer;
      const normalizeId = (value: unknown, idx: number): string => {
        const rawId = typeof value === "string" && value.trim() ? value.trim() : `task-${idx + 1}`;
        return rawId.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80) || `task-${idx + 1}`;
      };
      for (const [idx, item] of rawItems.entries()) {
        const id = normalizeId((item as any).id, idx);
        if (seenIds.has(id)) {
          return {
            content: [{ type: "text" as const, text: `TASK PLAN REJECTED: duplicate task id '${id}'.` }],
            details: { rejected: true, reason: "duplicate_task_id", id },
          };
        }
        seenIds.add(id);
      }
      seenIds.clear();
      const scrub = (text: unknown, source: string): string => {
        const processed = processModelVisibleText({
          text: String(text ?? ""),
          source,
          classification: "untrusted_data_plane",
          dlp,
          sanitizer,
        });
        dlp = processed.dlp;
        sanitizer = processed.sanitizer;
        return processed.text;
      };

      const items: TaskPlanItem[] = rawItems.map((item: any, idx: number) => {
        const id = normalizeId(item.id, idx);
        seenIds.add(id);
        return {
          id,
          title: scrub(item.title, "goal_update_task_plan.title").slice(0, 240),
          status: item.status as TaskPlanItemStatus,
          detail: typeof item.detail === "string" ? scrub(item.detail, "goal_update_task_plan.detail").slice(0, 1000) : null,
          evidence: Array.isArray(item.evidence)
            ? item.evidence.map((entry: unknown) => scrub(entry, "goal_update_task_plan.evidence").slice(0, 1000)).slice(0, 20)
            : [],
          updatedAt: new Date().toISOString(),
        };
      });

      const taskPlan = {
        updatedAt: new Date().toISOString(),
        updatedByPhaseAttemptId: String(params.phaseAttemptId),
        rationale: typeof params.rationale === "string" ? scrub(params.rationale, "goal_update_task_plan.rationale").slice(0, 1000) : null,
        items,
      };

      stateManager.updateDlpState(dlp);
      stateManager.updateSanitizationState(sanitizer);
      stateManager.updateTaskPlan(taskPlan);

      const counts = items.reduce<Record<TaskPlanItemStatus, number>>((acc, item) => {
        acc[item.status] += 1;
        return acc;
      }, { pending: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0 });

      return {
        content: [{ type: "text" as const,
          text: `Task plan updated: ${items.length} items (${counts.completed} completed, ${counts.in_progress} in_progress, ${counts.pending} pending, ${counts.blocked} blocked).` }],
        details: { rejected: false, taskPlan },
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

  pi.registerTool({
    name: "cyber_checkpoint", label: "Cyber Checkpoint",
    description: "Force a DLP-aware cyber state checkpoint.",
    parameters: Type.Object({}),
    async execute() {
      stateManager.persistAll();
      const state = stateManager.getState();
      return {
        content: [{ type: "text" as const, text: "Cyber state checkpoint created." }],
        details: {
          runId: state?.runId ?? null,
          dlpRedactions: state?.dlp.redactionCount ?? 0,
          attestations: state?.attestations.length ?? 0,
          pendingApprovals: state?.approvals.pending.length ?? 0,
        },
      };
    },
  });
}
