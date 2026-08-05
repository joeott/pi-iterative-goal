import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { createErrorRecord } from "../errors.js";
import { findFirstHealthyFallback, loadConfiguredModel } from "../kernel/workflow-engine.js";
import { type StateManagerAPI } from "../state.js";
import { PlanSpecSchema, type PlanSpec, type PlanTask } from "../domain/plan.js";
import { normalizeRepoPath, type PathScope } from "../domain/path-scope.js";
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

/** The id charset rule shared by goal_update_task_plan item ids and typed-plan ids (C2-OUS-009 parity). */
function normalizeIdToken(value: unknown, fallback: string): string {
  const rawId = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return rawId.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80) || fallback;
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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = stateManager.getState();
      if (!state) {
        return { content: [{ type: "text" as const, text: "No active run; approval request ignored." }], details: { rejected: true } };
      }
      if (!state.lock.activePhaseId) {
        return { content: [{ type: "text" as const, text: "No active phase attempt; approval request rejected." }], details: { rejected: true } };
      }
      const token = `APPROVAL_${state.runId}_${state.cycle}_${crypto.randomBytes(4).toString("hex")}`;
      const now = Date.now();
      const maximumExpiry = now + 10 * 60_000;
      const requestedExpiry = typeof params.expires_at === "string" ? Date.parse(params.expires_at) : NaN;
      // The untrusted requester may shorten a token lifetime, never extend it.
      const expiryMs = Number.isFinite(requestedExpiry)
        ? Math.min(requestedExpiry, maximumExpiry)
        : maximumExpiry;
      const expiresAt = new Date(expiryMs).toISOString();
      const request = {
        token,
        runId: state.runId,
        cycle: state.cycle,
        phaseAttemptId: state.lock.activePhaseId,
        cwd: path.resolve(ctx.cwd),
        requestedAction: String(params.requested_action),
        blastRadiusAssessment: String(params.blast_radius_assessment),
        justification: String(params.justification),
        rollbackPlan: String(params.rollback_plan),
        affectedResources: (params.affected_resources as string[] | undefined) ?? [],
        exactCommands: (params.exact_commands as string[] | undefined) ?? [],
        exactAwsActions: (params.exact_aws_actions as string[] | undefined) ?? [],
        dataAccessScope: typeof params.data_access_scope === "string" ? params.data_access_scope : null,
        requestedAt: new Date().toISOString(),
        expiresAt,
        status: "pending" as const,
        resolvedAt: null,
        usedAt: null,
        usedForCommand: null,
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
      const normalizeId = (value: unknown, idx: number): string => normalizeIdToken(value, `task-${idx + 1}`);
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

  // Campaign 2 (§6.1): typed-plan ingress for the sharder. The model posts
  // its plan as PlanSpecSchema JSON during the plan phase; the sharder hook
  // evaluates it at the plan→implement transition and commits shard_posted.
  // The free-text plan artifact and goal_update_task_plan checklist remain
  // the primary path — this is additive.
  pi.registerTool({
    name: "goal_post_shards",
    label: "Post Shard Plan",
    description: "Post this cycle's typed plan as PlanSpecSchema JSON (from the plan prompt's Typed Plan Contract). The sharder evaluates it at the plan→implement transition. Must include runId and phaseAttemptId from [HARNESS_META].",
    promptSnippet: "Post the typed PlanSpec JSON for shard evaluation",
    promptGuidelines: [
      "Call goal_post_shards during the plan phase with the PlanSpecSchema JSON described by the Typed Plan Contract. Include runId and phaseAttemptId from [HARNESS_META].",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "MUST match [HARNESS_META] runId" }),
      phaseAttemptId: Type.String({ description: "MUST match [HARNESS_META] phaseAttemptId" }),
      plan: PlanSpecSchema,
    }),

    async execute(_toolCallId, params): Promise<any> {
      const state = stateManager.getState();
      const rejectReason = checkStaleWriteGuard(state, params as any, "goal_post_shards");
      if (rejectReason) {
        return {
          content: [{ type: "text" as const,
            text: rejectStale(stateManager, state, rejectReason, params as any) }],
          details: { rejected: true, reason: rejectReason },
        };
      }

      const s = state!;
      if (s.phase !== "plan") {
        return {
          content: [{ type: "text" as const,
            text: `SHARD PLAN REJECTED: goal_post_shards is only valid during the plan phase (current: ${s.phase}).` }],
          details: { rejected: true, reason: "wrong_phase", phase: s.phase },
        };
      }

      // Lenient normalization of untrusted model output into the strict
      // PlanSpec contract: string scopes become typed scopes, optional
      // arrays default, checks default to required, and ids (plan.id,
      // task.id, dependsOn) get the same charset rule as goal_update_task_plan
      // item ids (C2-OUS-009) — applied BEFORE validation so dependsOn
      // references normalize onto their task ids.
      const rawPlan = params.plan as any;
      const rawTasks: any[] = Array.isArray(rawPlan?.tasks) ? rawPlan.tasks : [];
      const candidate = {
        id: normalizeIdToken(rawPlan?.id, "plan-1"),
        version: typeof rawPlan?.version === "number" ? rawPlan.version : 1,
        createdAt: typeof rawPlan?.createdAt === "string" ? rawPlan.createdAt : new Date().toISOString(),
        tasks: rawTasks.map((task, taskIndex) => {
          const scopes = (Array.isArray(task?.allowedPaths) ? task.allowedPaths : []).map((scope: unknown) => {
            if (typeof scope === "string") {
              return scope.includes("*")
                ? { kind: "glob", pattern: scope }
                : { kind: "exact", path: scope };
            }
            return scope;
          });
          return {
            id: normalizeIdToken(task?.id, `task-${taskIndex + 1}`),
            title: typeof task?.title === "string" ? task.title : "",
            dependsOn: (Array.isArray(task?.dependsOn) ? task.dependsOn : [])
              .map((dependency: unknown) => normalizeIdToken(dependency, ""))
              .filter((dependency: string) => dependency.length > 0),
            satisfies: Array.isArray(task?.satisfies) ? task.satisfies : [],
            allowedPaths: scopes,
            requiredCapabilities: Array.isArray(task?.requiredCapabilities) ? task.requiredCapabilities : [],
            checks: (Array.isArray(task?.checks) ? task.checks : []).map((check: any) => ({ required: true, ...check })),
            rollback: typeof task?.rollback === "string" ? task.rollback : "",
            risk: typeof task?.risk === "string" ? task.risk : "medium",
          };
        }),
      };

      if (!Value.Check(PlanSpecSchema, candidate)) {
        const issues = [...Value.Errors(PlanSpecSchema, candidate)]
          .slice(0, 5)
          .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`);
        return {
          content: [{ type: "text" as const,
            text: `SHARD PLAN REJECTED: plan does not match PlanSpecSchema. ${issues.join("; ")}` }],
          details: { rejected: true, reason: "schema_validation", issues },
        };
      }
      const plan = candidate as PlanSpec;

      const taskIds = new Set<string>();
      for (const task of plan.tasks) {
        if (taskIds.has(task.id)) {
          return {
            content: [{ type: "text" as const, text: `SHARD PLAN REJECTED: duplicate task id '${task.id}'.` }],
            details: { rejected: true, reason: "duplicate_task_id", id: task.id },
          };
        }
        taskIds.add(task.id);
      }
      for (const task of plan.tasks) {
        const missing = task.dependsOn.filter((dependency) => !taskIds.has(dependency));
        if (missing.length > 0) {
          return {
            content: [{ type: "text" as const,
              text: `SHARD PLAN REJECTED: task '${task.id}' depends on unknown task(s): ${missing.join(", ")}.` }],
            details: { rejected: true, reason: "unknown_dependency", id: task.id, missing },
          };
        }
      }

      // Allowlist paths must normalize (same machinery that verifies diffs);
      // un-normalizable paths are rejected, not silently dropped.
      const badPaths: string[] = [];
      // Scrub ALL free-text string fields through the same DLP/IPI path as
      // goal_update_task_plan (C2-ADV-005); ids are charset-validated instead
      // (normalizeIdToken above), paths are charset-validated below.
      const scrubText = (text: string, source: string, limit: number): string =>
        scrubPhaseSummary(s, text, source).text.slice(0, limit);
      const normalizedTasks: PlanTask[] = plan.tasks.map((task) => {
        const allowedPaths: PathScope[] = [];
        for (const scope of task.allowedPaths) {
          const raw = scope.kind === "exact" ? scope.path : scope.pattern;
          try {
            const normalized = normalizeRepoPath(raw);
            allowedPaths.push(scope.kind === "exact"
              ? { kind: "exact", path: normalized }
              : { kind: "glob", pattern: normalized });
          } catch {
            badPaths.push(raw);
          }
        }
        return {
          ...task,
          title: scrubText(task.title, "goal_post_shards.title", 240),
          rollback: scrubText(task.rollback, "goal_post_shards.rollback", 1000),
          checks: task.checks.map((check) => ({
            ...check,
            name: scrubText(check.name, "goal_post_shards.check.name", 240),
            command: check.command
              ? {
                ...check.command,
                executable: scrubText(check.command.executable, "goal_post_shards.check.executable", 240),
                argv: check.command.argv.map((arg) => scrubText(arg, "goal_post_shards.check.argv", 240)),
              }
              : undefined,
          })),
          allowedPaths,
        };
      });
      if (badPaths.length > 0) {
        return {
          content: [{ type: "text" as const,
            text: `SHARD PLAN REJECTED: allowlist paths are not repository-relative: ${badPaths.join(", ")}.` }],
          details: { rejected: true, reason: "invalid_paths", paths: badPaths },
        };
      }

      const normalizedPlan: PlanSpec = { ...plan, tasks: normalizedTasks };
      stateManager.setPendingShardPlan({
        plan: normalizedPlan,
        cycle: s.cycle,
        postedAt: new Date().toISOString(),
        phaseAttemptId: String(params.phaseAttemptId),
      });

      const allowlistFiles = new Set(
        normalizedTasks.flatMap((task) => task.allowedPaths.map((scope) =>
          scope.kind === "exact" ? scope.path : scope.pattern)),
      );
      return {
        content: [{ type: "text" as const,
          text: `Typed plan posted: ${normalizedPlan.tasks.length} task(s), ${allowlistFiles.size} allowlist path(s). The sharder evaluates it at the plan→implement transition.` }],
        details: {
          rejected: false,
          planId: normalizedPlan.id,
          version: normalizedPlan.version,
          tasks: normalizedPlan.tasks.length,
          allowlistPaths: allowlistFiles.size,
        },
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
        const currentAttempt = state.phaseAttempts.at(-1);
        const from = currentAttempt
          ? { provider: currentAttempt.modelProvider, model: currentAttempt.modelModel }
          : state.config.primaryModel;
        const attempted: Array<{ provider: string; model: string }> = [from];

        while (true) {
          const fallback = findFirstHealthyFallback(state, attempted);
          if (!fallback) break;
          attempted.push(fallback);
          const loaded = await loadConfiguredModel(ctx, pi, fallback.provider, fallback.model);
          if (!loaded.loaded) continue;

          if (currentAttempt) {
            currentAttempt.fallbackChain.push({ ...from, reason: "model_incompatible" });
            currentAttempt.modelProvider = loaded.route.provider;
            currentAttempt.modelModel = loaded.route.model;
          }

          stateManager.recordPhaseEvent({
            runId: state.runId, cycle: state.cycle, phase: state.phase,
            phaseAttemptId: currentAttempt?.phaseAttemptId ?? "",
            attempt: currentAttempt?.attempt ?? 1,
            kind: "model_fallback", timestamp: new Date().toISOString(),
            details: {
              from: `${from.provider}/${from.model}`,
              to: loaded.route.piSelection,
              profileId: loaded.route.profileId,
              reason: "model_incompatible",
            },
          });
          stateManager.persistAll();

          return {
            content: [{ type: "text" as const,
              text: `Switched to exact fallback: ${loaded.route.piSelection}. Retry the phase.` }],
            details: { profileId: loaded.route.profileId },
          };
        }

        if (state.lock.activePhaseId) stateManager.releaseLock(state.runId, state.lock.activePhaseId);
        state.lock.phaseStatus = "paused";
        stateManager.recordError({
          timestamp: new Date().toISOString(), phase: state.phase, cycle: state.cycle,
          kind: "provider_tool_route_incompatible",
          rawText: `No exact fallback model could be loaded for: ${params.what}`,
          recoveryAction: "Repair provider configuration and run /goal-repair-capabilities.",
          resolved: false,
        });
        stateManager.setStatus("provider_unavailable");
        return {
          content: [{ type: "text" as const,
            text: "No configured exact fallback could be loaded. The run is suspended as provider_unavailable." }],
          details: { rejected: true, status: "provider_unavailable" },
        };
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
    name: "goal_launch", label: "Goal Launch",
    description:
      "Launch an autonomous iterative goal loop with a drafted goal and completion criterion. " +
      "Equivalent to the /goal-start command. Use after drafting a well-formed goal contract " +
      "(for example from a source document the user pointed at) so the loop starts without the " +
      "user retyping it. The loop then runs research → plan → implement → validate cycles under " +
      "evaluator verdicts until the completion criterion is met.",
    parameters: Type.Object({
      goal: Type.String({
        description: "The goal statement. Do not include a '#criterion:' section here.",
        minLength: 1,
      }),
      criterion: Type.Optional(Type.String({
        description:
          "Explicit, verifiable completion criteria (checks the harness can execute and attest: " +
          "commands, exit codes, artifact existence). Defaults to the standard criterion when omitted.",
      })),
    }),
    async execute(_toolCallId, params) {
      const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
      const goal = oneLine(params.goal).replace(/#criterion:.*/i, "").trim();
      if (!goal) {
        const details: Record<string, unknown> = { rejected: true, reason: "empty_goal" };
        return {
          content: [{ type: "text" as const, text: "goal_launch rejected: goal is empty." }],
          details,
        };
      }
      const criterion = oneLine(params.criterion ?? "") ||
        "All explicit completion criteria are satisfied, validation passes, and state is reproducible.";
      pi.sendUserMessage(`/goal-start ${goal} #criterion: ${criterion}`, { deliverAs: "followUp" });
      options.log?.(`Goal launch queued: goal="${goal}"`);
      const details: Record<string, unknown> = { rejected: false, queued: true, goal, criterion };
      return {
        content: [{ type: "text" as const,
          text: `Queued /goal-start with the drafted goal (${goal.length} chars) and completion criterion. The iterative goal loop will start when this turn finishes.` }],
        details,
      };
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
