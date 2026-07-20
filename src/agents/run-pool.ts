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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentPool,
  type AgentResult,
  type AgentTask,
  type PoolCancelStatus,
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
  return `${runId}${cwd}`;
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
  // Run-boundary teardown: pools of earlier runs are shut down so their
  // cross-call activeWriteScopes registry dies with the run (§5.1).
  for (const [key, entry] of [...runAgentPools.entries()]) {
    if (entry.runId !== runId) {
      void entry.pool.shutdown?.();
      runAgentPools.delete(key);
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

export async function dispatchAgentTask(
  deps: DispatchAgentTaskDeps,
  agentTask: AgentTask,
): Promise<DispatchOutcome> {
  const { pool, broker, stateManager, runId, batchId, mode, backend, detectedBackend, cwd, signal } = deps;
  const writerTask = agentTask.workspace === "isolated_worktree";

  const record: SubagentTaskRecord = {
    taskId: agentTask.id,
    batchId,
    runId,
    role: agentTask.role,
    mode,
    backend,
    detectedBackend,
    workspace: agentTask.workspace,
    allowedPaths: [...agentTask.allowedPaths],
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    usage: null,
    error: null,
  };

  // Cancel-before-admission: queued-cancelled work is never executed, so the
  // ledger never claims cancelled for work that ran (C1-ADV-004).
  if (pool.wasCancelled?.(agentTask.id)) {
    stateManager?.recordSubagentStarted(record);
    stateManager?.recordSubagentFinished(agentTask.id, { runId, status: "cancelled", error: "cancelled_before_admission" });
    pool.unnoteQueued?.(agentTask.id);
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
    stateManager?.recordSubagentFinished(agentTask.id, { runId, status: "failed", error });
    return { task: agentTask, ok: false, status: "failed", result: null, policyDecision: brokered.decision, policyError: error };
  }

  const result = brokered.output;
  const cancelled = pool.wasCancelled?.(agentTask.id) === true;
  const status = cancelled ? "cancelled" : result.ok ? "completed" : "failed";
  stateManager?.recordSubagentFinished(agentTask.id, {
    runId,
    status,
    usage: result.usage,
    error: result.ok ? null : result.stderr || `exit code ${result.exitCode ?? "unknown"}`,
  });
  return { task: agentTask, ok: result.ok, status, result, policyDecision: brokered.decision };
}
