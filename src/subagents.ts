/**
 * Subagent adapter - detects actual available subagent mechanisms
 * and provides fallbacks. Never confuses MCP servers with subagent packages.
 *
 * Campaign 1 (deployment plan Ch. 5): the dormant `tasks[]`/`mode` schema is
 * wired to real supervisor→specialist fan-out — a long-lived per-run pool
 * with a cross-call write-scope registry (src/agents/run-pool.ts), per-role
 * profiles from src/agents/roles.ts, and subagent_started/subagent_finished
 * ledger events. mode:"parallel"|"chain" stay disabled by default behind
 * iterativeGoal.swarm.enabled (.pi/settings.json of the SESSION cwd); the
 * single-agent fallback contract is preserved throughout.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type CapabilitySnapshot,
  type SubagentBackend,
  type SubagentExecutionMode,
} from "./types.js";
import { detectSubagentBackend } from "./capabilities.js";
import {
  type AgentPool,
  type AgentResult,
  type AgentTask,
  DEFAULT_SWARM_CONCURRENCY,
  MAX_SWARM_CONCURRENCY,
  PiSubprocessAgentPool,
  createAgentTask,
  pathsOverlap,
} from "./agents/pool.js";
import {
  type AgentRole,
  AGENT_ROLES,
  getRoleProfile,
  isTestScopedPath,
} from "./agents/roles.js";
import {
  type DispatchOutcome,
  type RunAgentPoolEntry,
  dispatchAgentTask,
  getRunAgentPool,
  peekRunAgentPool,
} from "./agents/run-pool.js";
import { CapabilityBroker } from "./capabilities/broker.js";
import { PolicyEngine, type PolicyDecision } from "./policy/engine.js";
import type { StateManagerAPI } from "./state.js";
import { logDebug } from "./logging.js";

function log(msg: string) {
  logDebug("subagents", msg);
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Swarm feature flag (.pi/settings.json → iterativeGoal.swarm) ──────

export interface SwarmConfig {
  /** mode:"parallel"|"chain" are disabled by default (campaign lands flag-off). */
  enabled: boolean;
  /** Default parallel fan-out; hard cap MAX_SWARM_CONCURRENCY (§5.1). */
  defaultConcurrency: number;
}

function parseProjectSettings(cwd: string): Record<string, unknown> {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch (err) {
    log(`Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function loadSwarmConfig(cwd: string): SwarmConfig {
  const settings = parseProjectSettings(cwd);
  const iterativeGoal = settings.iterativeGoal && typeof settings.iterativeGoal === "object"
    ? settings.iterativeGoal as Record<string, unknown>
    : {};
  const swarm = iterativeGoal.swarm && typeof iterativeGoal.swarm === "object"
    ? iterativeGoal.swarm as Record<string, unknown>
    : {};
  const requested = typeof swarm.defaultConcurrency === "number" && Number.isFinite(swarm.defaultConcurrency)
    ? Math.floor(swarm.defaultConcurrency)
    : DEFAULT_SWARM_CONCURRENCY;
  return {
    enabled: swarm.enabled === true,
    defaultConcurrency: Math.max(1, Math.min(requested, MAX_SWARM_CONCURRENCY)),
  };
}

// ── Backend label ─────────────────────────────────────────────────────

export function formatBackendLabel(backend: SubagentBackend): string {
  switch (backend.kind) {
    case "tool": return `tool:${backend.toolName}`;
    case "command": return `command:${backend.commandName}`;
    default: return "none";
  }
}

// ── Batch building (per-role profiles) ────────────────────────────────

export interface SubagentBatchEntry {
  id?: string;
  /** Scalar form only: display name for the fallback line. */
  agent?: string;
  role: AgentRole;
  task: string;
  allowedPaths: string[];
  model?: string;
  inputArtifactIds: string[];
}

export function buildAgentTaskFromProfile(
  entry: SubagentBatchEntry,
): { ok: true; task: AgentTask } | { ok: false; error: string } {
  const profile = getRoleProfile(entry.role);
  if (profile.allowedPathsPolicy !== "none" && entry.allowedPaths.length === 0) {
    return {
      ok: false,
      error: `POLICY BLOCK: writer subagents require explicit allowedPaths and an isolated worktree lease (role: ${entry.role}).`,
    };
  }
  if (profile.allowedPathsPolicy === "tests_only" && !entry.allowedPaths.every(isTestScopedPath)) {
    return {
      ok: false,
      error: `POLICY BLOCK: Test engineer allowedPaths must stay within test paths (tests/**, __tests__/**, *.test.*, *.spec.*).`,
    };
  }
  return {
    ok: true,
    task: createAgentTask(entry.role, entry.task, {
      id: entry.id,
      modelProfile: entry.model ?? "",
      workspace: profile.workspace,
      permittedEffects: [...profile.permittedEffects],
      allowedPaths: [...entry.allowedPaths],
      inputArtifactIds: [...entry.inputArtifactIds],
      budget: { ...profile.budget },
      outputSchema: profile.outputSchema,
    }),
  };
}

// ── Shardability gate (Ch. 7 safeguard, §5.3) ─────────────────────────

export type ShardViolation =
  | { kind: "write_scope_conflict"; holdingTaskId: string; taskId: string; overlappingPaths: string[] }
  | { kind: "shared_context"; taskId: string; dependsOnTaskId: string }
  | { kind: "not_independently_verifiable"; taskId: string };

/**
 * Mode-agnostic decomposition violations, reusable by the C3 scheduler:
 * - write_scope_conflict: writer allowedPaths pairwise overlap;
 * - shared_context: a task consumes an in-batch sibling's output (ordering dependency);
 * - not_independently_verifiable: a task lacks a typed output schema.
 */
export function findShardViolations(tasks: AgentTask[]): ShardViolation[] {
  const violations: ShardViolation[] = [];
  const writers = tasks.filter((task) => task.workspace === "isolated_worktree");
  for (let i = 0; i < writers.length; i += 1) {
    for (let j = i + 1; j < writers.length; j += 1) {
      if (pathsOverlap(writers[i].allowedPaths, writers[j].allowedPaths)) {
        violations.push({
          kind: "write_scope_conflict",
          holdingTaskId: writers[i].id,
          taskId: writers[j].id,
          overlappingPaths: [...writers[i].allowedPaths],
        });
      }
    }
  }
  const batchIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const artifactId of task.inputArtifactIds) {
      if (batchIds.has(artifactId)) {
        violations.push({ kind: "shared_context", taskId: task.id, dependsOnTaskId: artifactId });
      }
    }
  }
  for (const task of tasks) {
    if (!task.outputSchema) violations.push({ kind: "not_independently_verifiable", taskId: task.id });
  }
  return violations;
}

export type ShardabilityVerdict =
  | { ok: true }
  | {
    ok: false;
    rejected: true;
    reason: "write_scope_conflict";
    holdingTaskId: string;
    taskId: string;
    overlappingPaths: string[];
  }
  | { ok: false; rejected: false; demotedTo: "chain" | "single"; reasons: string[] };

/** Thin tool-side mapper: violations → reject (hard conflict) or demote verdict. */
export function checkShardability(tasks: AgentTask[]): ShardabilityVerdict {
  const violations = findShardViolations(tasks);
  const conflict = violations.find(
    (violation): violation is Extract<ShardViolation, { kind: "write_scope_conflict" }> =>
      violation.kind === "write_scope_conflict",
  );
  if (conflict) {
    return {
      ok: false,
      rejected: true,
      reason: "write_scope_conflict",
      holdingTaskId: conflict.holdingTaskId,
      taskId: conflict.taskId,
      overlappingPaths: conflict.overlappingPaths,
    };
  }
  if (violations.length === 0) return { ok: true };
  const reasons = violations.map((violation) =>
    violation.kind === "shared_context"
      ? `task ${violation.taskId} consumes the output of in-batch sibling ${violation.dependsOnTaskId} (ordering dependency)`
      : `task ${violation.taskId} is missing a typed output schema`);
  const demotedTo = violations.some((violation) => violation.kind === "not_independently_verifiable")
    ? "single"
    : "chain";
  return { ok: false, rejected: false, demotedTo, reasons };
}

// ── Adapter tool ────────────────────────────────────────────────────

const AgentRoleEnum = StringEnum([...AGENT_ROLES] as const, {
  description: "Typed subagent role. Defaults to Scout.",
  default: "Scout",
});

const GoalSubagentParams = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent role/name to invoke",
  })),
  role: Type.Optional(AgentRoleEnum),
  task: Type.Optional(Type.String({ description: "Task to delegate to the subagent (scalar form; equivalent to a one-element tasks[] batch)" })),
  tasks: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.String({
      description: "Optional stable task id (defaults to a random one). Must be unique per batch and per in-flight task in the run. Other tasks' inputArtifactIds may reference it for chain handoff.",
    })),
    role: Type.Optional(AgentRoleEnum),
    task: Type.String({ description: "Task to delegate to the subagent" }),
    allowedPaths: Type.Optional(Type.Array(Type.String(), {
      description: "Required for writer roles; repository-relative paths the subagent may modify in its isolated worktree.",
    })),
    model: Type.Optional(Type.String({
      description: "Optional Pi model ID to pass to the subprocess backend",
    })),
    inputArtifactIds: Type.Optional(Type.Array(Type.String(), {
      description: "Artifact/task ids whose recorded outputs bind into this task's instructions (chain mode).",
    })),
  }), {
    description: "Batch of subagent tasks. Executed per mode: single (sequential), parallel (AgentPool.map fan-out), chain (artifact handoff in array order).",
  })),
  allowedPaths: Type.Optional(Type.Array(Type.String(), {
    description: "Required for writer roles; repository-relative paths the subagent may modify in its isolated worktree.",
  })),
  model: Type.Optional(Type.String({
    description: "Optional Pi model ID to pass to the subprocess backend",
  })),
  mode: Type.Optional(
    StringEnum(["single", "parallel", "chain"] as const, {
      description: "Execution mode. Default: single. parallel/chain require iterativeGoal.swarm.enabled (default off); while disabled they demote to single.",
      default: "single",
    }),
  ),
  concurrency: Type.Optional(Type.Number({
    description: `Parallel fan-out width for mode:parallel. Default ${DEFAULT_SWARM_CONCURRENCY}, hard cap ${MAX_SWARM_CONCURRENCY}.`,
  })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

export interface GoalSubagentDetails {
  backendKind: SubagentBackend["kind"];
  backendDetail: string;
  fallback: boolean;
  result: string;
  policyDecision?: PolicyDecision;
  mode?: SubagentExecutionMode;
  requestedMode?: SubagentExecutionMode;
  swarmModesDisabled?: boolean;
  batchId?: string;
  detectedBackend?: string;
  demotedFrom?: SubagentExecutionMode;
  demotionReasons?: string[];
  duplicateTaskId?: string;
  degraded?: boolean;
  unresolvedArtifacts?: string[];
  gate?: {
    rejected: boolean;
    reason?: string;
    holdingTaskId?: string;
    taskId?: string;
    overlappingPaths?: string[];
  };
  tasks?: Array<{
    taskId: string;
    role: string;
    ok: boolean;
    status: string;
    degraded?: boolean;
    usage?: AgentResult["usage"];
  }>;
}

export interface GoalSubagentServices {
  /** Ledger + run context. Threaded from src/index.ts; null means stateless. */
  stateManager?: StateManagerAPI | null;
  /** Injectable for tests; defaults to `which <command>`. */
  commandExists?: (command: string) => boolean;
  /** Injectable for tests; defaults to a PiSubprocessAgentPool per cwd. */
  poolFactory?: (cwd: string) => AgentPool;
  /** Injectable for tests; defaults to loadSwarmConfig(ctx.cwd).enabled. */
  swarmEnabled?: boolean;
}

export function registerGoalSubagentTool(
  pi: ExtensionAPI,
  getSnapshot: () => CapabilitySnapshot | null,
  services: GoalSubagentServices = {},
): void {
  pi.registerTool({
    name: "goal_subagent",
    label: "Goal Subagent",
    description: [
      "Delegate scouting/research tasks to subagents when a subagent backend is available.",
      "Accepts a scalar task or a tasks[] batch executed per mode (single/parallel/chain).",
      "When no backend is detected, falls back to single-agent scouting in the current session.",
      "Do not call 'subagent' or 'Agent' tools directly; use goal_subagent.",
    ].join(" "),
    promptSnippet: "Run subagent tasks with automatic backend detection and fallback",
    promptGuidelines: [
      "Use goal_subagent for scouting/research delegation instead of calling subagent or Agent tools directly. The goal_subagent tool automatically detects available backends and handles fallback.",
    ],
    parameters: GoalSubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const stateManager = services.stateManager ?? null;
      const runState = stateManager?.getState() ?? null;
      const runId = runState?.runId ?? "goal_subagent";
      const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
      // The feature flag reads the SESSION settings only — never params.cwd,
      // which is caller-controlled (C1-ADV-009).
      const swarmConfig = loadSwarmConfig(ctx.cwd);
      const swarmEnabled = services.swarmEnabled ?? swarmConfig.enabled;
      const snapshot = getSnapshot();
      const backend = snapshot
        ? detectSubagentBackend(pi, snapshot)
        : ({ kind: "none" as const });
      const detectedBackend = formatBackendLabel(backend);
      const commandExistsFn = services.commandExists ?? commandExists;

      // ── Build the batch (scalar task ≡ one-element tasks[]) ──────
      const batch = normalizeBatch(params);
      const batchId = `batch-${crypto.randomBytes(4).toString("hex")}`;
      log(`goal_subagent called: mode=${String(params.mode ?? "single")}, tasks=${batch.length}, backend=${backend.kind}, runId=${runId}`);

      if (batch.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "goal_subagent requires a non-empty task (scalar `task` or at least one `tasks[]` entry).",
          }],
          details: {
            backendKind: backend.kind,
            backendDetail: "missing-task",
            fallback: true,
            result: "missing-task",
            detectedBackend,
          } satisfies GoalSubagentDetails,
          isError: true,
        };
      }

      const agentTasks: AgentTask[] = [];
      for (const entry of batch) {
        const built = buildAgentTaskFromProfile(entry);
        if (!built.ok) {
          return {
            content: [{
              type: "text" as const,
              text: built.error,
            }],
            details: {
              backendKind: "none",
              backendDetail: "writer-subagents-require-allowed-paths",
              fallback: true,
              result: "policy-blocked",
              detectedBackend,
              batchId,
            } satisfies GoalSubagentDetails,
            isError: true,
          };
        }
        agentTasks.push(built.task);
      }

      // ── Duplicate caller-provided ids (C1-ADV-001) ───────────────
      const duplicateTaskId = findDuplicateTaskId(
        agentTasks,
        stateManager,
        runState ? peekRunAgentPool(runId, cwd) : null,
      );
      if (duplicateTaskId) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "[DUPLICATE TASK ID]",
              "",
              `Task id '${duplicateTaskId}' is already used within this batch or by an in-flight subagent task in this run.`,
              "Choose unique ids per task; duplicate ids corrupt the write-scope registry and the ledger.",
            ].join("\n"),
          }],
          details: {
            backendKind: backend.kind,
            backendDetail: "duplicate-task-id",
            fallback: false,
            result: "duplicate-task-id",
            detectedBackend,
            duplicateTaskId,
            batchId,
          } satisfies GoalSubagentDetails,
          isError: true,
        };
      }

      // ── Mode resolution (feature flag + one-task normalization) ──
      const requestedMode = (params.mode as SubagentExecutionMode | undefined) ?? "single";
      let mode: SubagentExecutionMode = requestedMode;
      let swarmModesDisabled = false;
      if (mode !== "single" && !swarmEnabled) {
        mode = "single";
        swarmModesDisabled = true;
      }
      // A one-task batch is effectively single regardless of the requested
      // mode — normalized BEFORE any ledger recording (C1-ADV-016).
      if (mode !== "single" && agentTasks.length === 1) mode = "single";

      // ── Backend / fallback contract ──────────────────────────────
      if (!commandExistsFn("pi")) {
        return {
          content: [
            {
              type: "text" as const,
              text: renderFallbackText(batch),
            },
          ],
          details: {
            backendKind: "none",
            backendDetail: "No subagent tool, agent tool, or command detected",
            fallback: true,
            result: "single-agent-fallback",
            detectedBackend,
            mode,
            requestedMode,
            swarmModesDisabled: swarmModesDisabled || undefined,
            batchId,
          } satisfies GoalSubagentDetails,
        };
      }

      // ── Shardability gate (parallel fan-out only) ────────────────
      // Runs BEFORE the run pool is fetched, so a rejected batch never
      // constructs/touches pool state (C1-ADV-003).
      let demotedFrom: SubagentExecutionMode | undefined;
      let demotionReasons: string[] | undefined;
      if (mode === "parallel") {
        const verdict = checkShardability(agentTasks);
        if (!verdict.ok && verdict.rejected) {
          log(`shardability gate rejected batch ${batchId}: holding=${verdict.holdingTaskId}, conflicting=${verdict.taskId}`);
          return {
            content: [{
              type: "text" as const,
              text: [
                "[SHARDABILITY GATE: REJECTED]",
                "",
                `Parallel batch rejected: writer tasks have overlapping write scopes.`,
                `Holding task: ${verdict.holdingTaskId} (allowedPaths: ${verdict.overlappingPaths.join(", ")})`,
                `Conflicting task: ${verdict.taskId}`,
                "",
                `Re-issue with disjoint allowedPaths, or request mode:"chain" for ordered execution.`,
              ].join("\n"),
            }],
            details: {
              backendKind: backend.kind,
              backendDetail: "PiSubprocessAgentPool",
              fallback: false,
              result: "shardability-gate-rejected",
              detectedBackend,
              mode: "parallel",
              requestedMode,
              batchId,
              gate: {
                rejected: true,
                reason: verdict.reason,
                holdingTaskId: verdict.holdingTaskId,
                taskId: verdict.taskId,
                overlappingPaths: verdict.overlappingPaths,
              },
            } satisfies GoalSubagentDetails,
            isError: true,
          };
        }
        if (!verdict.ok && !verdict.rejected) {
          demotedFrom = "parallel";
          demotionReasons = verdict.reasons;
          mode = verdict.demotedTo;
          log(`shardability gate demoted batch ${batchId} to ${mode}: ${verdict.reasons.join("; ")}`);
        }
      }

      // ── Pool acquisition ─────────────────────────────────────────
      // Stateful runs share the long-lived run pool (cross-call write-scope
      // registry); stateless calls get a per-call pool torn down after the
      // call — swarm activity outside a run keeps the pre-C1 behavior.
      const poolFactory = services.poolFactory ?? ((poolCwd: string) => new PiSubprocessAgentPool(poolCwd));
      const ownedPool = runState ? null : poolFactory(cwd);
      const pool = runState
        ? getRunAgentPool(runId, cwd, { pi, snapshot, poolFactory }).pool
        : ownedPool!;

      try {
        const broker = new CapabilityBroker(new PolicyEngine({ repoRoot: cwd }));
        const concurrency = Math.max(
          1,
          Math.min(
            typeof params.concurrency === "number" && Number.isFinite(params.concurrency)
              ? Math.floor(params.concurrency)
              : swarmConfig.defaultConcurrency,
            MAX_SWARM_CONCURRENCY,
          ),
        );
        const dispatchDeps = {
          pool,
          broker,
          stateManager,
          runId,
          batchId,
          mode,
          backend: "pi-subprocess",
          detectedBackend,
          cwd,
          signal: _signal ?? undefined,
        };
        for (const agentTask of agentTasks) pool.noteQueued?.(agentTask.id);

        // ── Dispatch per mode (one shared dispatch path) ───────────
        const outcomes: DispatchOutcome[] = [];
        const unresolvedArtifacts: string[] = [];
        if (mode === "parallel") {
          // Bounded fan-out (default 4, cap 8). Inline worker loop over the
          // shared dispatch primitive — each worker gates through the broker,
          // so AgentPool.map (which submits directly) cannot be used here.
          let next = 0;
          const workers = Math.min(concurrency, agentTasks.length);
          await Promise.all(new Array(workers).fill(null).map(async () => {
            while (next < agentTasks.length) {
              const index = next++;
              outcomes[index] = await dispatchAgentTask(dispatchDeps, agentTasks[index]);
            }
          }));
        } else if (mode === "chain") {
          // Sequential, in array order; inputArtifactIds bind predecessor outputs (§5.1).
          const artifactOutputs = new Map<string, string>();
          for (const agentTask of agentTasks) {
            unresolvedArtifacts.push(...bindInputArtifacts(agentTask, artifactOutputs));
            const outcome = await dispatchAgentTask(dispatchDeps, agentTask);
            outcomes.push(outcome);
            artifactOutputs.set(agentTask.id, outcome.result?.outputText ?? outcome.policyError ?? "");
          }
        } else {
          // mode:"single" — current behavior: task(s) submitted one at a time.
          for (const agentTask of agentTasks) {
            outcomes.push(await dispatchAgentTask(dispatchDeps, agentTask));
          }
        }

        // ── Render outcomes ────────────────────────────────────────
        if (outcomes.length === 1) {
          const outcome = outcomes[0];
          if (outcome.policyError) {
            return {
              content: [{
                type: "text" as const,
                text: `SUBAGENT POLICY BLOCK: ${outcome.policyError}`,
              }],
              details: {
                backendKind: backend.kind,
                backendDetail: "PiSubprocessAgentPool",
                fallback: true,
                result: "policy-blocked",
                policyDecision: outcome.policyDecision,
                detectedBackend,
                mode,
                requestedMode,
                swarmModesDisabled: swarmModesDisabled || undefined,
                demotedFrom,
                demotionReasons,
                batchId,
                tasks: [taskSummary(outcome)],
              } satisfies GoalSubagentDetails,
              isError: true,
            };
          }
          const result = outcome.result!;
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  ...(swarmModesDisabled
                    ? [`[SWARM MODES DISABLED] mode:"${requestedMode}" requested but iterativeGoal.swarm.enabled is off; executed as mode:"single".`, ""]
                    : []),
                  result.ok
                    ? result.outputText || "(subagent completed with no text output)"
                    : [
                        `[SUBAGENT FAILED: ${result.exitCode ?? "spawn-error"}]`,
                        result.stderr || result.outputText || "No subprocess output.",
                        "",
                        "Fallback: perform this work in the current session.",
                      ].join("\n"),
                ].join("\n"),
              },
            ],
            details: {
              backendKind: backend.kind,
              backendDetail: "PiSubprocessAgentPool",
              fallback: !result.ok,
              result: JSON.stringify(result),
              policyDecision: outcome.policyDecision,
              detectedBackend,
              mode,
              requestedMode,
              swarmModesDisabled: swarmModesDisabled || undefined,
              demotedFrom,
              demotionReasons,
              degraded: result.degraded || undefined,
              batchId,
              tasks: [taskSummary(outcome)],
            } satisfies GoalSubagentDetails,
            isError: !result.ok,
          };
        }

        const allFailed = outcomes.every((outcome) => !outcome.ok);
        const sections: string[] = [];
        if (swarmModesDisabled) {
          sections.push(`[SWARM MODES DISABLED] mode:"${requestedMode}" requested but iterativeGoal.swarm.enabled is off; executed as mode:"single".`, "");
        }
        if (demotedFrom) {
          sections.push(`[SHARDABILITY GATE] mode:"${demotedFrom}" demoted to mode:"${mode}": ${(demotionReasons ?? []).join("; ")}`, "");
        }
        for (const outcome of outcomes) {
          const icon = outcome.ok ? "✓" : outcome.status === "cancelled" ? "⊘" : "✗";
          const degradedNote = outcome.result?.degraded
            ? "\n(degraded: output failed schema validation; prose preserved)"
            : "";
          const body = outcome.policyError
            ? `POLICY BLOCK: ${outcome.policyError}`
            : (outcome.result?.outputText || outcome.result?.stderr || "(no output)") + degradedNote;
          sections.push(`[${icon} ${outcome.task.role} ${outcome.task.id}]`, body, "");
        }

        return {
          content: [{ type: "text" as const, text: sections.join("\n").trim() }],
          details: {
            backendKind: backend.kind,
            backendDetail: "PiSubprocessAgentPool",
            fallback: allFailed,
            result: JSON.stringify(outcomes.map(taskSummary)),
            detectedBackend,
            mode,
            requestedMode,
            swarmModesDisabled: swarmModesDisabled || undefined,
            demotedFrom,
            demotionReasons,
            unresolvedArtifacts: unresolvedArtifacts.length > 0 ? unresolvedArtifacts : undefined,
            batchId,
            tasks: outcomes.map(taskSummary),
          } satisfies GoalSubagentDetails,
          isError: allFailed,
        };
      } finally {
        if (ownedPool) await ownedPool.shutdown?.();
      }
    },
  });
}

/** Duplicate ids corrupt the write-scope registry and the ledger (C1-ADV-001). */
function findDuplicateTaskId(
  tasks: AgentTask[],
  stateManager: StateManagerAPI | null,
  poolEntry: RunAgentPoolEntry | null,
): string | null {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) return task.id;
    seen.add(task.id);
  }
  const inFlightLedger = stateManager?.getState()?.swarm.tasks
    .filter((task) => task.status === "running")
    .map((task) => task.taskId) ?? [];
  for (const id of seen) {
    if (inFlightLedger.includes(id)) return id;
    if (poolEntry?.pool.isTaskActive?.(id)) return id;
  }
  return null;
}

function taskSummary(outcome: DispatchOutcome): {
  taskId: string;
  role: string;
  ok: boolean;
  status: string;
  degraded?: boolean;
  usage?: AgentResult["usage"];
} {
  return {
    taskId: outcome.task.id,
    role: outcome.task.role,
    ok: outcome.ok,
    status: outcome.status,
    degraded: outcome.result?.degraded || undefined,
    usage: outcome.result?.usage,
  };
}

function normalizeBatch(params: Record<string, unknown>): SubagentBatchEntry[] {
  const batch: SubagentBatchEntry[] = [];
  if (Array.isArray(params.tasks)) {
    for (const raw of params.tasks) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const task = typeof entry.task === "string" ? entry.task.trim() : "";
      if (!task) continue;
      batch.push({
        id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined,
        role: (entry.role as AgentRole | undefined) ?? "Scout",
        task,
        allowedPaths: Array.isArray(entry.allowedPaths) ? entry.allowedPaths as string[] : [],
        model: typeof entry.model === "string" ? entry.model : undefined,
        inputArtifactIds: Array.isArray(entry.inputArtifactIds) ? entry.inputArtifactIds as string[] : [],
      });
    }
  }
  if (batch.length === 0 && typeof params.task === "string" && params.task.trim()) {
    batch.push({
      role: (params.role as AgentRole | undefined) ?? "Scout",
      agent: typeof params.agent === "string" ? params.agent : undefined,
      task: params.task.trim(),
      allowedPaths: Array.isArray(params.allowedPaths) ? params.allowedPaths as string[] : [],
      model: typeof params.model === "string" ? params.model : undefined,
      inputArtifactIds: [],
    });
  }
  return batch;
}

/** Per-artifact prompt budget for chain handoff (C1-OUS-014). */
const CHAIN_ARTIFACT_MAX_CHARS = 4_000;

/**
 * Chain-mode artifact-first handoff: bind recorded predecessor outputs into
 * instructions, truncated to a sane budget (writer outputs carry
 * [ISOLATED_WORKTREE_PATCH] blocks). Returns unresolved inputArtifactIds.
 */
function bindInputArtifacts(agentTask: AgentTask, artifactOutputs: Map<string, string>): string[] {
  const unresolved: string[] = [];
  if (agentTask.inputArtifactIds.length === 0) return unresolved;
  const sections: string[] = [];
  for (const artifactId of agentTask.inputArtifactIds) {
    const output = artifactOutputs.get(artifactId);
    if (output === undefined) {
      unresolved.push(artifactId);
      sections.push(`--- artifact ${artifactId} ---\n(unresolved: no recorded output)`);
      continue;
    }
    const bound = output.length > CHAIN_ARTIFACT_MAX_CHARS
      ? `${output.slice(0, CHAIN_ARTIFACT_MAX_CHARS)}\n[truncated ${output.length - CHAIN_ARTIFACT_MAX_CHARS} chars]`
      : output;
    sections.push(`--- artifact ${artifactId} ---\n${bound}`);
  }
  agentTask.instructions = [
    "Input artifacts from predecessor tasks:",
    "",
    ...sections,
    "",
    agentTask.instructions,
  ].join("\n");
  return unresolved;
}

/** §5.4 fallback contract: full task list rendered for sequential in-context execution. */
function renderFallbackText(batch: SubagentBatchEntry[]): string {
  const lines = [
    "[SUBAGENT BACKEND: NONE]",
    "",
    batch.length === 1
      ? `Task that would have been delegated to '${batch[0].agent ?? batch[0].role}': ${batch[0].task}`
      : [
          `Tasks that would have been delegated (${batch.length}):`,
          ...batch.map((entry, index) => {
            const scope = entry.allowedPaths.length > 0 ? ` (allowedPaths: ${entry.allowedPaths.join(", ")})` : "";
            return `  ${index + 1}. [${entry.role}] ${entry.task}${scope}`;
          }),
        ].join("\n"),
    "",
    "No subagent backend is available. Perform this scouting/research work",
    "in the current session sequentially using single-agent scouting.",
    "",
    "Use read, grep, find, ls, and goal_shell to explore the codebase.",
  ];
  return lines.join("\n");
}
