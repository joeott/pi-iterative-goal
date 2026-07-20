/**
 * Run-scoped agent pool registry and dispatch primitive (deployment plan
 * Ch. 5 §5.1).
 *
 * The registry owns the long-lived per-run pool: created lazily on first
 * swarm use, keyed by runId + cwd, torn down at run boundaries (prune on
 * access here; explicit shutdown wired into goal completion and /goal-reset).
 * The pool's cross-call activeWriteScopes registry lives and dies with it.
 *
 * dispatchAgentTask is THE single dispatch path — broker gate → pool.submit →
 * subagent_started/subagent_finished ledger events → cancel/status mapping —
 * shared by mode:"single"|"parallel"|"chain" and reusable by Campaign 3's
 * scheduler (§5.1: the scheduler emits parallel batches and chains as
 * primitive operations rather than re-implementing dispatch).
 */

import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentPool,
  type AgentResult,
  type AgentTask,
  type PoolCancelStatus,
  DEFAULT_MODEL_PROFILE_BY_ROLE,
  PiSubprocessAgentPool,
  buildPiSubprocessArgs,
} from "./pool.js";
import { CapabilityBroker } from "../capabilities/broker.js";
import { commandResource, PolicyEngine, type PolicyDecision } from "../policy/engine.js";
import { parsePathScope } from "../domain/path-scope.js";
import { detectSubagentBackend } from "../capabilities.js";
import type { StateManagerAPI } from "../state.js";
import type {
  CapabilitySnapshot,
  SubagentBackend,
  SubagentExecutionMode,
  SubagentTaskRecord,
} from "../types.js";
import { logDebug } from "../logging.js";
import { requireModelRoute, type ResolvedModelRoute } from "../domain/model-roster.js";
import { recordModelInvocation, type ModelTermination } from "../model-telemetry.js";

function log(msg: string) {
  logDebug("run-pool", msg);
}

// ── Run → pool registry ───────────────────────────────────────────────

export interface RunAgentPoolEntry {
  runId: string;
  cwd: string;
  pool: AgentPool;
  /** Backend detected once per run at pool construction (§5.1). */
  backend: SubagentBackend;
  createdAt: string;
}

const runAgentPools = new Map<string, RunAgentPoolEntry>();

function poolKey(runId: string, cwd: string): string {
  return `${runId}\0${cwd}`;
}

export function getRunAgentPool(
  runId: string,
  cwd: string,
  deps: {
    pi?: ExtensionAPI;
    snapshot?: CapabilitySnapshot | null;
    poolFactory?: (cwd: string) => AgentPool;
  } = {},
): RunAgentPoolEntry {
  // Teardown is asynchronous and must be awaited by the lifecycle before a
  // new run can admit work. Never fire-and-forget an old pool and then erase
  // its ownership record while detached children may still be alive.
  for (const entry of runAgentPools.values()) {
    if (entry.runId !== runId) {
      throw new Error(`prior run pool ${entry.runId} is still registered; await shutdownRunAgentPools before admitting ${runId}`);
    }
  }
  const key = poolKey(runId, cwd);
  const existing = runAgentPools.get(key);
  if (existing) return existing;
  const backend = deps.pi && deps.snapshot
    ? detectSubagentBackend(deps.pi, deps.snapshot)
    : ({ kind: "none" } as const);
  const factory = deps.poolFactory ?? ((poolCwd: string) => new PiSubprocessAgentPool(poolCwd));
  const entry: RunAgentPoolEntry = { runId, cwd, pool: factory(cwd), backend, createdAt: new Date().toISOString() };
  runAgentPools.set(key, entry);
  return entry;
}

/** Look up an existing pool without creating one (validation paths). */
export function peekRunAgentPool(runId: string, cwd: string): RunAgentPoolEntry | null {
  return runAgentPools.get(poolKey(runId, cwd)) ?? null;
}

export async function shutdownRunAgentPools(): Promise<void> {
  for (const entry of runAgentPools.values()) await entry.pool.shutdown?.();
  runAgentPools.clear();
}

/** Operator/supervisor cancellation surface (§5.4); releases the task's write scope. */
export async function cancelRunSubagent(runId: string, taskId: string): Promise<PoolCancelStatus | null> {
  let sawPool = false;
  for (const entry of runAgentPools.values()) {
    if (entry.runId !== runId) continue;
    sawPool = true;
    const status = await entry.pool.cancel(taskId);
    if (status !== "unknown") return status;
  }
  return sawPool ? "unknown" : null;
}

// ── Dispatch primitive ────────────────────────────────────────────────

export interface DispatchAgentTaskDeps {
  pool: AgentPool;
  broker: CapabilityBroker;
  stateManager: StateManagerAPI | null;
  runId: string;
  batchId: string;
  mode: SubagentExecutionMode;
  /** Executed backend recorded on the ledger ("pi-subprocess" — the only engine today). */
  backend: string;
  /** Detection result, carried separately for diagnostics (C1-ADV-002). */
  detectedBackend: string;
  cwd: string;
  /** Why orchestration selected a non-primary route; null for direct dispatch. */
  fallbackReason?: string | null;
  signal?: AbortSignal;
}

export interface DispatchOutcome {
  task: AgentTask;
  ok: boolean;
  status: "completed" | "failed" | "cancelled";
  result: AgentResult | null;
  policyDecision?: PolicyDecision;
  policyError?: string;
}

interface TerminalTelemetryInput {
  deps: DispatchAgentTaskDeps;
  task: AgentTask;
  route: ResolvedModelRoute;
  dispatchStartedAt: string;
  requestDigest: string;
  result: AgentResult | null;
  termination: ModelTermination;
  gateStatus: "PASS" | "FAIL" | "NOT_RUN";
  errorCode: string | null;
  resultDigest: string;
}

function sha256Parts(...parts: unknown[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    if (typeof part === "string") hash.update(part);
    else {
      try { hash.update(JSON.stringify(part)); }
      catch { hash.update(String(part)); }
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function requestDigest(task: AgentTask, deps: DispatchAgentTaskDeps, route: ResolvedModelRoute): string {
  // Prompt/instruction bytes contribute to the digest but are never placed in
  // telemetry metadata. This is an integrity handle, not prompt logging.
  return sha256Parts(task.instructions, {
    schema: "pi-iterative-goal.subagent-request-digest.v1",
    runId: deps.runId,
    batchId: deps.batchId,
    mode: deps.mode,
    taskId: task.id,
    role: task.role,
    inputArtifactIds: task.inputArtifactIds,
    outputSchema: task.outputSchema ?? null,
    permittedEffects: task.permittedEffects,
    allowedPaths: task.allowedPaths,
    workspace: task.workspace,
    routeId: route.profileId,
    budget: task.budget,
  });
}

function comparisonFixtureHash(task: AgentTask): string {
  // Stable across route/run/task-id changes, but distinct when any workload,
  // contract, input binding, effect scope, or budget changes.
  return sha256Parts("pi-iterative-goal.subagent-comparison-fixture.v1", {
    role: task.role,
    instructions: task.instructions,
    inputArtifactIds: [...task.inputArtifactIds].sort(),
    outputSchema: task.outputSchema ?? null,
    permittedEffects: [...task.permittedEffects].sort(),
    allowedPaths: [...task.allowedPaths].sort(),
    workspace: task.workspace,
    budget: task.budget,
  });
}

function agentResultDigest(result: AgentResult): string {
  // Hash the bounded result content without persisting it. The result object is
  // never passed as telemetry metadata.
  return sha256Parts(
    "pi-iterative-goal.subagent-result-digest.v1",
    result.outputText,
    result.stderr,
    result.patch ?? null,
    result.structuredOutput ?? null,
    {
      taskId: result.taskId,
      role: result.role,
      ok: result.ok,
      exitCode: result.exitCode,
      degraded: result.degraded ?? false,
      outputTruncated: result.outputTruncated ?? false,
      timing: result.timing,
      usage: result.usage,
    },
  );
}

function rosterCostUsd(route: ResolvedModelRoute, result: AgentResult | null): number | null {
  if (!result) return null;
  const components = [
    [result.usage.input, route.pricing.input],
    [result.usage.output, route.pricing.output],
    [result.usage.cacheRead, route.pricing.cacheRead],
    [result.usage.cacheWrite, route.pricing.cacheWrite],
  ] as const;
  let cost = 0;
  let pricedAnyTokens = false;
  for (const [tokens, pricePerMillion] of components) {
    if (!Number.isFinite(tokens) || tokens < 0) return null;
    if (tokens === 0) continue;
    if (pricePerMillion === null) return null;
    pricedAnyTokens = true;
    cost += (tokens / 1_000_000) * pricePerMillion;
  }
  return pricedAnyTokens ? cost : null;
}

function outputTokensPerSecond(result: AgentResult | null): number | null {
  if (!result || result.timing.firstTokenAt === null || result.usage.output <= 0) return null;
  const firstTokenMs = Date.parse(result.timing.firstTokenAt);
  const endedMs = Date.parse(result.timing.endedAt);
  const elapsedMs = endedMs - firstTokenMs;
  return Number.isFinite(elapsedMs) && elapsedMs > 0
    ? result.usage.output / (elapsedMs / 1_000)
    : null;
}

function responseModelMatches(route: ResolvedModelRoute, responseModel: string | null | undefined): boolean | null {
  if (!responseModel) return null;
  if (responseModel === route.model) return true;
  return route.profileId === "fireworks_glm_5_2_fast"
    && responseModel === "accounts/fireworks/models/glm-5p2";
}

function persistTerminalTelemetry(input: TerminalTelemetryInput): void {
  const { deps, task, route, result } = input;
  const current = deps.stateManager?.getState();
  const sameRun = current?.runId === deps.runId ? current : null;
  const timing = result?.timing ?? {
    startedAt: input.dispatchStartedAt,
    firstTokenAt: null,
    endedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - Date.parse(input.dispatchStartedAt)),
    ttftMs: null,
  };
  recordModelInvocation({
    invocationId: randomUUID(),
    runId: deps.runId,
    sessionId: null,
    cycle: sameRun?.cycle ?? null,
    phase: sameRun?.phase ?? null,
    phaseAttemptId: sameRun?.lock.activePhaseId ?? null,
    taskId: task.id,
    attempt: 1,
    role: task.role,
    workloadClass: `subagent:${task.role.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    fixtureHash: comparisonFixtureHash(task),
    routeId: route.profileId,
    provider: route.provider,
    requestedModel: route.model,
    responseModel: result?.responseModel ?? null,
    familyId: route.familyId,
    servingVariant: route.serving.variant,
    reasoningEffort: route.reasoning.variant === "none"
      ? null
      : route.reasoning.providerEffort ?? route.reasoning.piThinkingLevel,
    serviceTier: route.serving.serviceTier,
    fallbackReason: deps.fallbackReason ?? null,
    startedAt: timing.startedAt,
    firstTokenAt: timing.firstTokenAt,
    endedAt: timing.endedAt,
    latencyMs: timing.latencyMs,
    ttftMs: timing.ttftMs,
    outputTokensPerSecond: outputTokensPerSecond(result),
    inputTokens: result?.usage.input ?? 0,
    outputTokens: result?.usage.output ?? 0,
    cacheReadTokens: result?.usage.cacheRead ?? 0,
    cacheWriteTokens: result?.usage.cacheWrite ?? 0,
    reasoningTokens: null,
    costUsd: rosterCostUsd(route, result),
    turns: result?.usage.turns ?? 0,
    toolCallCount: result?.toolCallCount ?? 0,
    toolErrorCount: result?.toolErrorCount ?? 0,
    termination: input.termination,
    gateStatus: input.gateStatus,
    errorCode: input.errorCode,
    requestDigest: input.requestDigest,
    resultDigest: input.resultDigest,
  }, deps.cwd);
}

function telemetryFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `required_model_telemetry_failed:${detail}`;
}

export async function dispatchAgentTask(
  deps: DispatchAgentTaskDeps,
  agentTask: AgentTask,
): Promise<DispatchOutcome> {
  const { pool, broker, stateManager, runId, batchId, mode, backend, detectedBackend, cwd, signal } = deps;
  const writerTask = agentTask.workspace === "isolated_worktree";
  let route: ResolvedModelRoute;
  try {
    // Fail before a ledger start can claim an inexact or unlisted route.
    route = requireModelRoute(agentTask.modelProfile || DEFAULT_MODEL_PROFILE_BY_ROLE[agentTask.role]);
  } catch (error) {
    pool.unnoteQueued?.(agentTask.id);
    throw error;
  }
  const dispatchStartedAt = new Date().toISOString();
  const requestSha = requestDigest(agentTask, deps, route);

  const record: SubagentTaskRecord = {
    taskId: agentTask.id,
    batchId,
    runId,
    role: agentTask.role,
    mode,
    backend,
    detectedBackend,
    routeId: route.profileId,
    provider: route.provider,
    requestedModel: route.model,
    familyId: route.familyId,
    servingVariant: route.serving.variant,
    reasoningEffort: route.reasoning.variant === "none"
      ? null
      : route.reasoning.providerEffort ?? route.reasoning.piThinkingLevel,
    serviceTier: route.serving.serviceTier,
    fallbackReason: deps.fallbackReason ?? null,
    workspace: agentTask.workspace,
    allowedPaths: [...agentTask.allowedPaths],
    status: "running",
    startedAt: dispatchStartedAt,
    finishedAt: null,
    usage: null,
    error: null,
  };

  // Cancel-before-admission: queued-cancelled work is never executed, so the
  // ledger never claims cancelled for work that ran (C1-ADV-004).
  if (pool.wasCancelled?.(agentTask.id)) {
    stateManager?.recordSubagentStarted(record);
    pool.unnoteQueued?.(agentTask.id);
    try {
      persistTerminalTelemetry({
        deps, task: agentTask, route, dispatchStartedAt, requestDigest: requestSha,
        result: null, termination: "cancelled", gateStatus: "NOT_RUN",
        errorCode: "cancelled_before_admission",
        resultDigest: sha256Parts("pi-iterative-goal.subagent-result-digest.v1", "cancelled_before_admission", agentTask.id),
      });
    } catch (error) {
      const telemetryError = telemetryFailureMessage(error);
      stateManager?.recordSubagentFinished(agentTask.id, { runId, status: "failed", error: telemetryError });
      return { task: agentTask, ok: false, status: "failed", result: null, policyError: telemetryError };
    }
    stateManager?.recordSubagentFinished(agentTask.id, { runId, status: "cancelled", error: "cancelled_before_admission" });
    log(`task ${agentTask.id} skipped: cancelled before admission`);
    return { task: agentTask, ok: false, status: "cancelled", result: null };
  }

  stateManager?.recordSubagentStarted(record);

  const subprocessArgs = buildPiSubprocessArgs(agentTask);
  const brokered = await broker.invoke({
    id: `goal_subagent:${agentTask.id}`,
    actor: { kind: "tool", id: "goal_subagent" },
    runId,
    taskId: agentTask.id,
    effect: "process.exec",
    resource: commandResource("pi", subprocessArgs),
    input: {
      executable: "pi",
      argv: subprocessArgs,
      cwd,
      allowDestructive: writerTask,
      allowGitFinalization: false,
      // §5.4 lease expiry: the CapabilityLease TTL is aligned with the task
      // budget; the pool's budget-timeout SIGTERM + write-scope release is the
      // lease-enforcement mechanism. maxAttempts retry semantics are deferred.
      leaseTtlMs: agentTask.budget.timeoutMs,
    },
    purpose: `subagent:${agentTask.role}`,
    risk: writerTask ? "write" : "read",
    dataClassification: "internal",
    allowedPaths: agentTask.allowedPaths.map(parsePathScope),
  }, async () => pool.submit(agentTask, signal), signal);

  pool.unnoteQueued?.(agentTask.id);

  if (!brokered.ok || !brokered.output) {
    const error = brokered.error ?? brokered.decision.reason;
    const policyBlocked = brokered.decision.result !== "allow";
    try {
      persistTerminalTelemetry({
        deps, task: agentTask, route, dispatchStartedAt, requestDigest: requestSha,
        result: null,
        termination: policyBlocked ? "gate_failure" : "provider_error",
        gateStatus: policyBlocked ? "FAIL" : "NOT_RUN",
        errorCode: policyBlocked
          ? brokered.decision.ruleIds[0] ?? "capability_policy_blocked"
          : "subagent_dispatch_exception",
        resultDigest: sha256Parts(
          "pi-iterative-goal.subagent-result-digest.v1",
          brokered.requestId,
          brokered.decision.result,
          brokered.decision.ruleIds,
          error,
        ),
      });
    } catch (telemetryFailure) {
      const telemetryError = telemetryFailureMessage(telemetryFailure);
      stateManager?.recordSubagentFinished(agentTask.id, { runId, status: "failed", error: telemetryError });
      return { task: agentTask, ok: false, status: "failed", result: null, policyDecision: brokered.decision, policyError: telemetryError };
    }
    stateManager?.recordSubagentFinished(agentTask.id, { runId, status: "failed", error });
    return { task: agentTask, ok: false, status: "failed", result: null, policyDecision: brokered.decision, policyError: error };
  }

  const result = brokered.output;
  const cancelled = pool.wasCancelled?.(agentTask.id) === true;
  const responseIdentity = responseModelMatches(route, result.responseModel);
  const responseMismatch = responseIdentity === false;
  const status = cancelled ? "cancelled" : result.ok && !responseMismatch ? "completed" : "failed";
  const termination: ModelTermination = result.budgetExhausted
    ? "budget_exhausted"
    : cancelled
    ? "cancelled"
    : responseMismatch
      ? "provider_error"
    : result.degraded
      ? "schema_error"
      : result.ok
        ? "success"
        : result.timing.latencyMs >= agentTask.budget.timeoutMs
          ? "timeout"
          : "provider_error";
  try {
    persistTerminalTelemetry({
      deps, task: agentTask, route, dispatchStartedAt, requestDigest: requestSha,
      result,
      termination,
      gateStatus: agentTask.outputSchema
        ? (!responseMismatch && result.ok && !result.degraded && result.structuredOutput !== undefined ? "PASS" : "FAIL")
        : "NOT_RUN",
      errorCode: result.budgetExhausted
        ? `budget_exhausted_${result.budgetExhausted.limit}`
        : cancelled
        ? "cancelled_during_execution"
        : responseMismatch
          ? "response_model_mismatch"
        : result.degraded
          ? "structured_output_schema_error"
          : result.ok
            ? null
            : termination === "timeout"
              ? "task_budget_timeout"
              : "provider_process_error",
      resultDigest: agentResultDigest(result),
    });
  } catch (error) {
    const telemetryError = telemetryFailureMessage(error);
    stateManager?.recordSubagentFinished(agentTask.id, {
      runId,
      status: "failed",
      usage: result.usage,
      error: telemetryError,
    });
    return { task: agentTask, ok: false, status: "failed", result, policyDecision: brokered.decision, policyError: telemetryError };
  }
  stateManager?.recordSubagentFinished(agentTask.id, {
    runId,
    status,
    usage: result.usage,
    error: responseMismatch
      ? `response_model_mismatch:${result.responseModel}`
      : result.ok ? null : result.stderr || `exit code ${result.exitCode ?? "unknown"}`,
  });
  return { task: agentTask, ok: status === "completed" && result.ok, status, result, policyDecision: brokered.decision };
}
