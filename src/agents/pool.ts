import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { normalizeRepoPath } from "../domain/path-scope.js";
import { prepareIsolatedWorktree } from "../workspace/worktrees.js";
import type { IsolatedWorkspace } from "../workspace/worktrees.js";
import type { AgentRole } from "./roles.js";
import {
  hasVerifiedModelPricing,
  requireModelRoute,
  type ModelProfileId,
  type ResolvedModelRoute,
} from "../domain/model-roster.js";
import {
  WORKER_ENV,
  encodeWorkerAllowedPaths,
  workerMessageIdentityError,
  type WorkerMode,
} from "../worker-extension.js";
import { effectiveSwarmConcurrency, resolveAgentMemoryBudget } from "./memory-budget.js";

export type { AgentRole } from "./roles.js";
// The isolated-worktree primitive lives in src/workspace/worktrees.ts (C4
// promotion, §6.6) — re-exported here so existing pool consumers and tests
// keep a stable import path.
export { prepareIsolatedWorktree } from "../workspace/worktrees.js";
export type { IsolatedWorkspace } from "../workspace/worktrees.js";

/** Swarm fan-out band (§5.1): default 4, hard cap 8 — the single source. */
export const DEFAULT_SWARM_CONCURRENCY = 4;
export const MAX_SWARM_CONCURRENCY = 8;

export const DEFAULT_MODEL_PROFILE_BY_ROLE: Readonly<Record<AgentRole, ModelProfileId>> = Object.freeze({
  Scout: "cerebras_gpt_oss_120b",
  "Requirements analyst": "openrouter_kimi_k3",
  Planner: "openrouter_kimi_k3",
  Implementer: "fireworks_glm_5_2_fast",
  "Test engineer": "fireworks_glm_5_2_fast",
  "Security reviewer": "openrouter_claude_sonnet_5",
  "Architecture/Ousterhout advisor": "openrouter_claude_sonnet_5",
  "Documentation reviewer": "cerebras_gemma_4_31b",
  "Release reviewer": "openrouter_claude_fable_5",
  Integrator: "fireworks_glm_5_2_max",
});

/** What pool.cancel() found for the task id. */
export type PoolCancelStatus = "running" | "queued" | "unknown";

export interface AgentTask<T = unknown> {
  id: string;
  role: AgentRole;
  instructions: string;
  inputArtifactIds: string[];
  outputSchema?: object;
  permittedEffects: string[];
  allowedPaths: string[];
  workspace: "read_only_snapshot" | "isolated_worktree";
  modelProfile: string;
  dependsOn: string[];
  budget: {
    maxTurns: number;
    maxTokens: number;
    timeoutMs: number;
    maxCost?: number;
  };
}

export interface AgentResult<T = unknown> {
  taskId: string;
  role: AgentRole;
  ok: boolean;
  outputText: string;
  structuredOutput?: T;
  exitCode: number | null;
  stderr: string;
  workspacePath?: string;
  /**
   * The isolated worktree's captured diff; "" when nothing changed; null/
   * undefined when capture FAILED (C4-ADV-011 — failure must stay
   * distinguishable from "no changes"; the merge layer rejects null).
   */
  patch?: string | null;
  /** True when the run succeeded but output failed schema validation (prose preserved). */
  degraded?: boolean;
  outputTruncated?: boolean;
  /** Kernel-observed hard budget stop; output/patch remains evidence only. */
  budgetExhausted?: AgentBudgetExhaustion;
  /** Effective Pi-observed identity from the last assistant response. */
  responseModel: string | null;
  /** Sticky response-identity failure observed on any finalized turn. */
  responseIdentityError?: AgentResponseIdentityError | null;
  /** Tool calls observed in finalized assistant content across all turns. */
  toolCallCount: number;
  /** Failed finalized tool-result messages observed across all turns. */
  toolErrorCount: number;
  timing: {
    startedAt: string;
    firstTokenAt: string | null;
    endedAt: string;
    latencyMs: number;
    ttftMs: number | null;
  };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
}

export type AgentResponseIdentityError =
  | "response_runtime_identity_missing"
  | "response_runtime_identity_mismatch"
  | "response_model_identity_missing"
  | "response_model_mismatch";

export type AgentBudgetLimit = "maxTurns" | "maxTokens" | "maxCost" | "timeoutMs";

export interface AgentBudgetExhaustion {
  reason: "budget_exhausted";
  limit: AgentBudgetLimit;
  maximum: number;
  /** Null means the provider omitted/invalidated a required usage measurement. */
  observed: number | null;
  detectedAt: string;
}

export interface AgentPool {
  submit<T>(task: AgentTask<T>, signal?: AbortSignal): Promise<AgentResult<T>>;
  map<T>(tasks: AgentTask<T>[], options?: { concurrency?: number; signal?: AbortSignal }): Promise<AgentResult<T>[]>;
  cancel(taskId: string): Promise<PoolCancelStatus>;
  /** Tear down a long-lived pool: kill in-flight tasks and release all write scopes. */
  shutdown?(): Promise<void>;
  /** Queue tracking so cancel() can report/admit queued-but-not-yet-running tasks. */
  noteQueued?(taskId: string): void;
  unnoteQueued?(taskId: string): void;
  /** True when a task was terminated/pre-empted via cancel()/shutdown(). */
  wasCancelled?(taskId: string): boolean;
  /** True while a task id is running or queued on this pool. */
  isTaskActive?(taskId: string): boolean;
}

export interface PiSubprocessAgentPoolOptions {
  /** Injectable spawn for tests; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Explicit executable for production launchers/tests; defaults to the repository-local Pi binary. */
  piExecutable?: string;
  /** Per-stream in-memory cap. Full output belongs in bounded managed logs, never an unbounded JS string. */
  maxCapturedBytes?: number;
  /** Grace between exact process-group TERM and KILL; injectable for tests. */
  killGraceMs?: number;
  /** Injectable OS birth-identity reader for deterministic PID-reuse tests. */
  readProcessIdentity?: ProcessIdentityReader;
  /** Injectable group-signalling primitive; receives a positive PGID. */
  signalProcessGroup?: ProcessGroupSignaller;
}

/** Kernel-observed identity captured for a newly spawned process-group leader. */
export interface ProcessBirthIdentity {
  pid: number;
  parentPid: number;
  processGroupId: number;
  /** Linux boot-id + start ticks, or Darwin's full process start timestamp. */
  startToken: string;
}

export type ProcessIdentityReader = (pid: number) => ProcessBirthIdentity | null;
export type ProcessGroupSignaller = (processGroupId: number, signal: NodeJS.Signals) => void;

interface OwnedWorkerProcess {
  child: ReturnType<typeof spawn>;
  pid: number | null;
  identity: ProcessBirthIdentity | null;
  /** Sticky: once identity fails, this record can never authorize a later PID reuse. */
  ownershipRevoked: boolean;
}

export class PiSubprocessAgentPool implements AgentPool {
  private readonly running = new Map<string, OwnedWorkerProcess>();
  // Cross-call write-scope registry: lives as long as the pool, so a writer
  // admitted by an earlier goal_subagent call still blocks colliding scopes.
  private readonly activeWriteScopes = new Map<string, string[]>();
  private readonly cancelledTasks = new Set<string>();
  private readonly queuedTasks = new Set<string>();
  private readonly spawnImpl: typeof spawn;
  private readonly piExecutable: string;
  private readonly maxCapturedBytes: number;
  private readonly killGraceMs: number;
  private readonly readProcessIdentity: ProcessIdentityReader;
  private readonly signalProcessGroup: ProcessGroupSignaller;
  private readonly closeWaiters = new Map<string, Promise<void>>();
  private readonly closeResolvers = new Map<string, () => void>();
  private readonly killEscalations = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly cwd: string, options: PiSubprocessAgentPoolOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.piExecutable = options.piExecutable ?? resolvePiExecutable(cwd);
    this.maxCapturedBytes = Math.max(64 * 1024, options.maxCapturedBytes ?? 5 * 1024 * 1024);
    this.killGraceMs = Math.max(1, options.killGraceMs ?? 5_000);
    this.readProcessIdentity = options.readProcessIdentity ?? readOsProcessIdentity;
    this.signalProcessGroup = options.signalProcessGroup ?? ((processGroupId, signal) => {
      process.kill(-processGroupId, signal);
    });
  }

  async submit<T>(task: AgentTask<T>, signal?: AbortSignal): Promise<AgentResult<T>> {
    // Cancel-before-admission guard: a task cancelled while queued is never
    // executed — the ledger may say cancelled only because nothing ran.
    if (this.cancelledTasks.has(task.id)) {
      return failedResult(task, `Task ${task.id} was cancelled before admission; it never executed.`);
    }
    if (signal?.aborted) {
      this.cancelledTasks.add(task.id);
      return failedResult(task, `Task ${task.id} was cancelled before admission; it never executed.`);
    }
    const invalidBudget = validateTaskBudget(task);
    if (invalidBudget) return failedResult(task, invalidBudget);
    let args: string[];
    let route: ResolvedModelRoute;
    try {
      route = requireModelRoute(task.modelProfile || DEFAULT_MODEL_PROFILE_BY_ROLE[task.role]);
      if (task.budget.maxCost !== undefined && !hasVerifiedModelPricing(route)) {
        throw new Error(`Task ${task.id} cannot enforce maxCost: verified pricing is unavailable for ${route.profileId}.`);
      }
      args = buildPiSubprocessArgs(task);
    } catch (err) {
      return failedResult(task, err instanceof Error ? err.message : String(err));
    }
    let workspace: IsolatedWorkspace | null = null;
    let runCwd = this.cwd;
    if (task.workspace === "isolated_worktree") {
      const conflict = this.findWriteScopeConflict(task);
      if (conflict) return failedResult(task, conflict);
      this.activeWriteScopes.set(task.id, task.allowedPaths);
    }
    try {
      // Readers get the same tracked-HEAD snapshot boundary as writers. This
      // excludes ambient untracked files (notably .env) from the child root.
      workspace = prepareIsolatedWorktree(this.cwd, task.id);
      runCwd = workspace.path;
    } catch (err) {
      this.activeWriteScopes.delete(task.id);
      return failedResult(task, err instanceof Error ? err.message : String(err));
    }

    const workerRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-worker-runtime-"));
    fs.chmodSync(workerRuntimeDir, 0o700);

    let workerEnvironment: NodeJS.ProcessEnv;
    try {
      workerEnvironment = buildWorkerEnvironment(process.env, {
        repoRoot: runCwd,
        mode: task.workspace,
        allowedPaths: task.allowedPaths,
        modelProfile: task.modelProfile || DEFAULT_MODEL_PROFILE_BY_ROLE[task.role],
        runtimeDir: workerRuntimeDir,
      });
    } catch (err) {
      this.activeWriteScopes.delete(task.id);
      workspace?.cleanup();
      cleanupWorkerRuntimeDir(workerRuntimeDir);
      return failedResult(task, err instanceof Error ? err.message : String(err));
    }

    return await new Promise<AgentResult<T>>((resolve) => {
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      let firstTokenAt: string | null = null;
      let firstTokenMs: number | null = null;
      let outputTruncated = false;
      let settled = false;
      let aborted = false;
      let budgetExhausted: AgentBudgetExhaustion | null = null;
      const proc = this.spawnImpl(this.piExecutable, args, {
        cwd: runCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: workerEnvironment,
      });
      const ownedProcess = captureOwnedWorkerProcess(proc, this.readProcessIdentity);
      this.running.set(task.id, ownedProcess);
      const closeWaiter = new Promise<void>((resolveClose) => this.closeResolvers.set(task.id, resolveClose));
      this.closeWaiters.set(task.id, closeWaiter);
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      const resultMetadata: MutableAgentResultMetadata = {
        responseModel: null,
        responseIdentityError: null,
        toolCallCount: 0,
        toolErrorCount: 0,
      };
      const exhaustBudget = (
        limit: AgentBudgetLimit,
        maximum: number,
        observed: number | null,
        signalChild = true,
      ): void => {
        if (budgetExhausted) return;
        budgetExhausted = {
          reason: "budget_exhausted",
          limit,
          maximum,
          observed,
          detectedAt: new Date().toISOString(),
        };
        // Budget enforcement owns the exact child process group. The write
        // scope is intentionally retained until `close`, including throughout
        // the bounded TERM -> KILL grace period.
        if (signalChild) {
          this.signalOwnedProcess(ownedProcess, "SIGTERM");
          this.scheduleKillEscalation(task.id, ownedProcess);
        }
      };
      const enforceBudget = (observation: UsageObservation, signalChild = true): void => {
        if (budgetExhausted || !observation.assistantTurn) return;
        // Exactly-at-limit is a valid terminal response. A tool-use response at
        // the limit would necessarily begin another provider turn, so stop it
        // before that continuation can be admitted.
        if (usage.turns > task.budget.maxTurns || (usage.turns === task.budget.maxTurns && observation.continues)) {
          exhaustBudget("maxTurns", task.budget.maxTurns, usage.turns, signalChild);
          return;
        }
        const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (!observation.tokensMeasured) {
          exhaustBudget("maxTokens", task.budget.maxTokens, null, signalChild);
          return;
        }
        if (tokens > task.budget.maxTokens || (tokens === task.budget.maxTokens && observation.continues)) {
          exhaustBudget("maxTokens", task.budget.maxTokens, tokens, signalChild);
          return;
        }
        if (task.budget.maxCost !== undefined) {
          if (!observation.costMeasured) {
            exhaustBudget("maxCost", task.budget.maxCost, null, signalChild);
            return;
          }
          if (usage.cost > task.budget.maxCost || (usage.cost === task.budget.maxCost && observation.continues)) {
            exhaustBudget("maxCost", task.budget.maxCost, usage.cost, signalChild);
          }
        }
      };
      const timeout = setTimeout(() => {
        // The timer firing is itself proof that the configured wall budget was
        // reached. Clamp coarse/adjusted wall-clock samples to that deadline so
        // receipts cannot report a timeout below their own maximum.
        exhaustBudget("timeoutMs", task.budget.timeoutMs, Math.max(task.budget.timeoutMs, Date.now() - startedMs));
      }, task.budget.timeoutMs);
      timeout.unref();

      const abort = () => {
        aborted = true;
        this.cancelledTasks.add(task.id);
        this.signalOwnedProcess(ownedProcess, "SIGTERM");
        this.scheduleKillEscalation(task.id, ownedProcess);
      };
      signal?.addEventListener("abort", abort, { once: true });

      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        if (firstTokenMs === null) {
          firstTokenMs = Date.now();
          firstTokenAt = new Date(firstTokenMs).toISOString();
        }
        const remaining = this.maxCapturedBytes - Buffer.byteLength(stdout);
        if (remaining > 0) stdout += Buffer.from(text).subarray(0, remaining).toString();
        if (Buffer.byteLength(text) > Math.max(0, remaining)) outputTruncated = true;
        const lines = (stdoutLineBuffer + text).split(/\r?\n/);
        const pendingLine = lines.pop() ?? "";
        if (Buffer.byteLength(pendingLine) > this.maxCapturedBytes) {
          // A finalized JSON event must fit within the same bounded capture
          // envelope as its output. Once framing exceeds that envelope, usage
          // is not trustworthy, so fail closed instead of parsing a tail.
          stdoutLineBuffer = "";
          outputTruncated = true;
          exhaustBudget("maxTokens", task.budget.maxTokens, null);
        } else {
          stdoutLineBuffer = pendingLine;
        }
        for (const line of lines) {
          const observation = accumulateUsageFromJsonLine(line, usage, resultMetadata, route);
          enforceBudget(observation);
        }
      });
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        const remaining = this.maxCapturedBytes - Buffer.byteLength(stderr);
        if (remaining > 0) stderr += Buffer.from(text).subarray(0, remaining).toString();
        if (Buffer.byteLength(text) > Math.max(0, remaining)) outputTruncated = true;
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        // Pi normally newline-terminates JSON mode events. Parse a final
        // complete line even when the child exits without that delimiter so a
        // provider cannot evade accounting through framing.
        if (stdoutLineBuffer.trim()) {
          enforceBudget(accumulateUsageFromJsonLine(stdoutLineBuffer, usage, resultMetadata, route), false);
          stdoutLineBuffer = "";
        }
        if (code === 0 && usage.turns === 0 && budgetExhausted === null) {
          // JSON mode success without one finalized, measured assistant turn
          // provides no trustworthy token accounting.
          exhaustBudget("maxTokens", task.budget.maxTokens, null, false);
        }
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.running.delete(task.id);
        this.activeWriteScopes.delete(task.id);
        this.clearKillEscalation(task.id);
        this.resolveCloseWaiter(task.id);
        // Capture failure is NOT "no changes" (C4-ADV-011): capturePatch
        // throws on git error; the reader path degrades to null and the
        // merge layer rejects null instead of verifying vanished work.
        let patch: string | null = null;
        try {
          patch = task.workspace === "isolated_worktree" ? workspace?.capturePatch() ?? null : null;
        } catch {
          patch = null;
        }
        const workspacePath = workspace?.path;
        workspace?.cleanup();
        cleanupWorkerRuntimeDir(workerRuntimeDir);
        const outputText = extractFinalText(stdout);
        const structured = validateStructuredOutput<T>(task, outputText);
        // Schema degradation: a validation failure never discards outputText —
        // prose reaches the supervisor with a validation note in stderr and the
        // result marked degraded instead of failed (C1-OUS-002 / C1-ADV-007).
        const degraded = code === 0 && budgetExhausted === null && !aborted && !structured.ok;
        const endedMs = Date.now();
        const timing = {
          startedAt,
          firstTokenAt,
          endedAt: new Date(endedMs).toISOString(),
          latencyMs: endedMs - startedMs,
          ttftMs: firstTokenMs === null ? null : firstTokenMs - startedMs,
        };
        resolve({
          taskId: task.id,
          role: task.role,
          ok: code === 0
            && budgetExhausted === null
            && !aborted
            && resultMetadata.responseIdentityError === null,
          outputText: patch ? `${outputText}\n\n[ISOLATED_WORKTREE_PATCH]\n${patch}`.trim() : outputText,
          structuredOutput: structured.value,
          exitCode: code,
          stderr: [
            stderr,
            structured.error,
            budgetExhausted ? formatBudgetExhaustion(budgetExhausted) : "",
            resultMetadata.responseIdentityError ?? "",
            aborted ? "cancelled_by_abort_signal" : "",
          ].filter(Boolean).join("\n"),
          workspacePath,
          patch,
          ...(degraded ? { degraded: true } : {}),
          ...(outputTruncated ? { outputTruncated: true } : {}),
          ...(budgetExhausted ? { budgetExhausted } : {}),
          ...resultMetadata,
          timing,
          usage,
        });
      });
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.running.delete(task.id);
        this.activeWriteScopes.delete(task.id);
        this.clearKillEscalation(task.id);
        this.resolveCloseWaiter(task.id);
        const workspacePath = workspace?.path;
        workspace?.cleanup();
        cleanupWorkerRuntimeDir(workerRuntimeDir);
        const endedMs = Date.now();
        resolve({
          taskId: task.id,
          role: task.role,
          ok: false,
          outputText: "",
          exitCode: null,
          stderr: [err.message, aborted ? "cancelled_by_abort_signal" : ""].filter(Boolean).join("\n"),
          workspacePath,
          ...resultMetadata,
          timing: {
            startedAt,
            firstTokenAt,
            endedAt: new Date(endedMs).toISOString(),
            latencyMs: endedMs - startedMs,
            ttftMs: firstTokenMs === null ? null : firstTokenMs - startedMs,
          },
          usage,
        });
      });
    });
  }

  async map<T>(tasks: AgentTask<T>[], options?: { concurrency?: number; signal?: AbortSignal }): Promise<AgentResult<T>[]> {
    const results: AgentResult<T>[] = new Array(tasks.length);
    // Default 4, hard cap 8 (§5.1): beyond ~8 parallel specialists,
    // coordination overhead and token cost dominate.
    const concurrency = Math.min(
      effectiveSwarmConcurrency(options?.concurrency ?? DEFAULT_SWARM_CONCURRENCY),
      tasks.length || 1,
    );
    let next = 0;
    await Promise.all(new Array(concurrency).fill(null).map(async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await this.submit<T>(tasks[index], options?.signal);
      }
    }));
    return results;
  }

  async cancel(taskId: string): Promise<PoolCancelStatus> {
    const ownedProcess = this.running.get(taskId);
    if (ownedProcess) {
      this.cancelledTasks.add(taskId);
      // The lease/write scope remains held until the owned process group
      // actually emits close. Releasing at signal time permits overlapping
      // writers while a slow child is still mutating the worktree.
      this.signalOwnedProcess(ownedProcess, "SIGTERM");
      this.scheduleKillEscalation(taskId, ownedProcess);
      return "running";
    }
    if (this.queuedTasks.delete(taskId)) {
      // Queued but never spawned: pre-empt admission so submit() refuses it.
      this.cancelledTasks.add(taskId);
      this.activeWriteScopes.delete(taskId);
      return "queued";
    }
    return "unknown";
  }

  async shutdown(): Promise<void> {
    for (const [taskId, ownedProcess] of this.running.entries()) {
      this.cancelledTasks.add(taskId);
      this.signalOwnedProcess(ownedProcess, "SIGTERM");
    }
    this.queuedTasks.clear();
    await waitForSettled([...this.closeWaiters.values()], 5_000);
    for (const ownedProcess of this.running.values()) this.signalOwnedProcess(ownedProcess, "SIGKILL");
    await waitForSettled([...this.closeWaiters.values()], 1_000);
    // If a broken spawn implementation never emits close, retain no reusable
    // pool state after shutdown; production children received SIGKILL above.
    this.running.clear();
    this.activeWriteScopes.clear();
    this.closeWaiters.clear();
    this.closeResolvers.clear();
    for (const timer of this.killEscalations.values()) clearTimeout(timer);
    this.killEscalations.clear();
  }

  noteQueued(taskId: string): void {
    this.queuedTasks.add(taskId);
  }

  unnoteQueued(taskId: string): void {
    this.queuedTasks.delete(taskId);
  }

  /** True when a task was terminated/pre-empted via cancel()/shutdown(). */
  wasCancelled(taskId: string): boolean {
    return this.cancelledTasks.has(taskId);
  }

  /** True while a task id is running or queued on this pool. */
  isTaskActive(taskId: string): boolean {
    return this.running.has(taskId) || this.queuedTasks.has(taskId);
  }

  /** Introspection for diagnostics and smoke tests. */
  getActiveWriteScopes(): ReadonlyMap<string, string[]> {
    return this.activeWriteScopes;
  }

  private findWriteScopeConflict(task: AgentTask): string | null {
    for (const [activeTaskId, activePaths] of this.activeWriteScopes.entries()) {
      if (pathsOverlap(activePaths, task.allowedPaths)) {
        return `Writer task ${task.id} overlaps active writer task ${activeTaskId}; overlapping writer scopes are denied.`;
      }
    }
    return null;
  }

  private resolveCloseWaiter(taskId: string): void {
    this.closeResolvers.get(taskId)?.();
    this.closeResolvers.delete(taskId);
    this.closeWaiters.delete(taskId);
  }

  private scheduleKillEscalation(taskId: string, ownedProcess: OwnedWorkerProcess): void {
    if (this.killEscalations.has(taskId)) return;
    const timer = setTimeout(() => {
      this.killEscalations.delete(taskId);
      // The identity check prevents a delayed timer from signalling a later
      // task that happens to reuse the same task id.
      if (this.running.get(taskId) === ownedProcess) this.signalOwnedProcess(ownedProcess, "SIGKILL");
    }, this.killGraceMs);
    timer.unref();
    this.killEscalations.set(taskId, timer);
  }

  private signalOwnedProcess(ownedProcess: OwnedWorkerProcess, signal: NodeJS.Signals): boolean {
    const { child, identity, pid } = ownedProcess;

    // Test doubles historically omit a PID. They cannot trigger a negative-PID
    // OS signal, so retaining the exact ChildProcess-handle fallback keeps the
    // injection seam useful without weakening the production path.
    if (pid === null) {
      try { return child.kill(signal); } catch { return false; }
    }

    // A real PID is never signalled through ChildProcess.kill: both it and a
    // negative-PGID kill ultimately trust a reusable integer. Authorize every
    // signal by re-reading the kernel start identity captured at spawn.
    if (ownedProcess.ownershipRevoked || identity === null) return false;
    const current = safeReadProcessIdentity(this.readProcessIdentity, pid);
    if (!sameProcessBirthIdentity(identity, current) || current.processGroupId !== pid) {
      ownedProcess.ownershipRevoked = true;
      return false;
    }

    try {
      this.signalProcessGroup(current.processGroupId, signal);
      return true;
    } catch (error) {
      if (hasProcessErrorCode(error, "ESRCH")) ownedProcess.ownershipRevoked = true;
      return false;
    }
  }

  private clearKillEscalation(taskId: string): void {
    const timer = this.killEscalations.get(taskId);
    if (timer) clearTimeout(timer);
    this.killEscalations.delete(taskId);
  }
}

interface UsageObservation {
  assistantTurn: boolean;
  tokensMeasured: boolean;
  costMeasured: boolean;
  continues: boolean;
}

interface MutableAgentResultMetadata {
  responseModel: string | null;
  responseIdentityError: AgentResponseIdentityError | null;
  toolCallCount: number;
  toolErrorCount: number;
}

function accumulateUsageFromJsonLine(
  line: string,
  usage: AgentResult["usage"],
  metadata: MutableAgentResultMetadata,
  route: ResolvedModelRoute,
): UsageObservation {
  const observation: UsageObservation = {
    assistantTurn: false,
    tokensMeasured: true,
    costMeasured: true,
    continues: false,
  };
  if (!line.trim()) return observation;
  try {
    const event = JSON.parse(line);
    const message = event.message;
    const assistantEnd = event.type === "message_end" && message?.role === "assistant";
    // message_start/message_update carry evolving cumulative usage snapshots.
    // Only the finalized assistant message is additive; summing streaming
    // snapshots would double-count and falsely exhaust hard budgets.
    if (assistantEnd && message?.usage) {
      const input = finiteNonNegative(message.usage.input);
      const output = finiteNonNegative(message.usage.output);
      const cacheRead = finiteNonNegative(message.usage.cacheRead ?? 0);
      const cacheWrite = finiteNonNegative(message.usage.cacheWrite ?? 0);
      const cost = finiteNonNegative(message.usage.cost?.total);
      observation.tokensMeasured = input !== null && output !== null && cacheRead !== null && cacheWrite !== null;
      observation.costMeasured = cost !== null;
      if (input !== null) usage.input += input;
      if (output !== null) usage.output += output;
      if (cacheRead !== null) usage.cacheRead += cacheRead;
      if (cacheWrite !== null) usage.cacheWrite += cacheWrite;
      if (cost !== null) usage.cost += cost;
    }
    if (assistantEnd) {
      usage.turns += 1;
      observation.assistantTurn = true;
      observation.continues = message.stopReason === "toolUse" || message.stopReason === "tool_use";
      const observedIdentityError = workerMessageIdentityError(route, message);
      const normalizedIdentityError: AgentResponseIdentityError | null = observedIdentityError === "response_model_identity_mismatch"
        ? "response_model_mismatch"
        : observedIdentityError;
      if (normalizedIdentityError !== null) {
        // Identity failure is sticky across turns. A later valid-looking turn
        // cannot rehabilitate a conversation that already used an unverified
        // or mismatched upstream model.
        metadata.responseIdentityError ??= normalizedIdentityError;
        metadata.responseModel = null;
      } else if (metadata.responseIdentityError === null) {
        metadata.responseModel = message.responseModel;
      }
      if (Array.isArray(message.content)) {
        metadata.toolCallCount += message.content.filter((part: unknown) => (
          !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall"
        )).length;
      }
      if (!message?.usage) {
        observation.tokensMeasured = false;
        observation.costMeasured = false;
      }
    }
    if (event.type === "message_end" && message?.role === "toolResult" && message.isError === true) {
      metadata.toolErrorCount += 1;
    }
  } catch {
    // Preserve raw output even if the subprocess emits non-JSON lines.
  }
  return observation;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validateTaskBudget(task: AgentTask): string | null {
  const { maxTurns, maxTokens, timeoutMs, maxCost } = task.budget;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) return `Task ${task.id} has invalid maxTurns budget.`;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return `Task ${task.id} has invalid maxTokens budget.`;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return `Task ${task.id} has invalid timeoutMs budget.`;
  if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0)) {
    return `Task ${task.id} has invalid maxCost budget.`;
  }
  return null;
}

function formatBudgetExhaustion(exhaustion: AgentBudgetExhaustion): string {
  return `budget_exhausted:${exhaustion.limit} observed=${exhaustion.observed ?? "unavailable"} maximum=${exhaustion.maximum}`;
}

export function buildPiSubprocessArgs(task: AgentTask): string[] {
  const schemaKeys = task.outputSchema
    ? Object.keys((task.outputSchema as { properties?: Record<string, unknown> }).properties ?? {})
    : [];
  const prompt = [
    `Role: ${task.role}`,
    "",
    "You are running as an isolated subagent for pi-iterative-goal.",
    `Workspace mode: ${task.workspace}`,
    `Permitted effects: ${task.permittedEffects.join(", ") || "none"}`,
    `Allowed paths: ${task.allowedPaths.join(", ") || "none"}`,
    "",
    task.instructions,
    "",
    schemaKeys.length > 0
      ? `Respond with a single JSON object (no surrounding prose) with keys: ${schemaKeys.join(", ")}.`
      : "Return concise structured findings.",
    "Do not claim success without evidence.",
  ].join("\n");

  // Workers get no ambient extensions, built-in tools, skills, templates,
  // context files, or session history. One explicit extension owns the entire
  // child capability surface, so neither Bash nor an ambient user tool can be
  // enabled by configuration discovery.
  const args = [
    "--mode", "json", "-p", "--no-session",
    "--no-extensions", "--extension", resolveWorkerExtensionPath(),
    "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-context-files",
  ];
  args.push("--tools", task.workspace === "isolated_worktree"
    ? "read,grep,find,ls,edit,write"
    : "read,grep,find,ls");
  const route = requireModelRoute(task.modelProfile || DEFAULT_MODEL_PROFILE_BY_ROLE[task.role]);
  args.push("--model", route.piSelection, "--thinking", route.reasoning.piThinkingLevel);
  args.push(prompt);
  return args;
}

function failedResult<T>(task: AgentTask<T>, stderr: string): AgentResult<T> {
  const now = new Date().toISOString();
  return {
    taskId: task.id,
    role: task.role,
    ok: false,
    outputText: "",
    exitCode: null,
    stderr,
    responseModel: null,
    toolCallCount: 0,
    toolErrorCount: 0,
    timing: { startedAt: now, firstTokenAt: null, endedAt: now, latencyMs: 0, ttftMs: null },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
}

export function resolvePiExecutable(repoRoot: string): string {
  const local = path.join(path.resolve(repoRoot), "node_modules", ".bin", "pi");
  return fs.existsSync(local) ? local : "pi";
}

export function resolveWorkerExtensionPath(): string {
  return fileURLToPath(new URL("../worker-extension.js", import.meta.url));
}

export interface WorkerEnvironmentConfig {
  repoRoot: string;
  mode: WorkerMode;
  allowedPaths: readonly string[];
  modelProfile: string;
  runtimeDir: string;
}

export function buildWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  config?: WorkerEnvironmentConfig,
): NodeJS.ProcessEnv {
  const ambient = [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "NO_COLOR",
    "PI_OFFLINE",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ambient) if (source[key] !== undefined) env[key] = source[key];

  if (config) {
    const route = requireModelRoute(config.modelProfile);
    for (const key of route.credential.environment) {
      if (source[key] !== undefined) env[key] = source[key];
    }
    env[WORKER_ENV.root] = fs.realpathSync(path.resolve(config.repoRoot));
    env[WORKER_ENV.mode] = config.mode;
    env[WORKER_ENV.allowedPaths] = encodeWorkerAllowedPaths(config.allowedPaths);
    env[WORKER_ENV.modelProfile] = route.profileId;
    env.PI_CODING_AGENT_DIR = fs.realpathSync(config.runtimeDir);
    env.PI_CODING_AGENT_SESSION_DIR = fs.realpathSync(config.runtimeDir);
  } else {
    // Backward-compatible diagnostics helper: production pool launches always
    // supply config and therefore receive only the selected route credential.
    for (const key of ["ZAI_API_KEY", "Z_AI_API_KEY", "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY"] as const) {
      if (source[key] !== undefined) env[key] = source[key];
    }
  }
  // Disable Pi's install telemetry in disposable workers; model-comparison
  // telemetry is recorded locally by this harness instead.
  env.PI_TELEMETRY = "0";
  // Rebuild NODE_OPTIONS from the numeric cmux contract. Never forward an
  // ambient string: NODE_OPTIONS can load arbitrary code via --require or
  // --import, and historical shells carried unsafe 48 GiB/8 GiB heap flags.
  const memory = resolveAgentMemoryBudget(source);
  env.NODE_OPTIONS = memory.nodeOptions;
  env.CMUX_MEMORY_PLAN_VERSION = String(memory.planVersion);
  env.CMUX_AGENT_OLD_SPACE_MIB = String(memory.oldSpaceMiB);
  env.CMUX_SWARM_MAX_CONCURRENCY = String(memory.maxConcurrency);
  env.CMUX_MEMORY_AVAILABLE_MIB = String(memory.availableMiB);
  return env;
}

function cleanupWorkerRuntimeDir(runtimeDir: string): void {
  const parent = fs.realpathSync(os.tmpdir());
  if (!fs.existsSync(runtimeDir)) return;
  const resolved = fs.realpathSync(runtimeDir);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("pi-ig-worker-runtime-")) {
    throw new Error(`refusing to clean unowned worker runtime directory: ${runtimeDir}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function captureOwnedWorkerProcess(
  child: ReturnType<typeof spawn>,
  readIdentity: ProcessIdentityReader,
): OwnedWorkerProcess {
  const pid = typeof child.pid === "number" && Number.isSafeInteger(child.pid) && child.pid > 0
    ? child.pid
    : null;
  if (pid === null) return { child, pid: null, identity: null, ownershipRevoked: false };

  const observed = safeReadProcessIdentity(readIdentity, pid);
  const identity = observed !== null
    && observed.pid === pid
    && observed.parentPid === process.pid
    && observed.processGroupId === pid
    && observed.startToken.length > 0
    ? observed
    : null;
  return { child, pid, identity, ownershipRevoked: identity === null };
}

function safeReadProcessIdentity(
  readIdentity: ProcessIdentityReader,
  pid: number,
): ProcessBirthIdentity | null {
  try {
    const identity = readIdentity(pid);
    if (identity === null
      || identity.pid !== pid
      || !Number.isSafeInteger(identity.parentPid)
      || identity.parentPid <= 0
      || !Number.isSafeInteger(identity.processGroupId)
      || identity.processGroupId <= 0
      || typeof identity.startToken !== "string"
      || identity.startToken.length === 0) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

function sameProcessBirthIdentity(
  expected: ProcessBirthIdentity,
  current: ProcessBirthIdentity | null,
): current is ProcessBirthIdentity {
  return current !== null
    && current.pid === expected.pid
    && current.parentPid === expected.parentPid
    && current.processGroupId === expected.processGroupId
    && current.startToken === expected.startToken;
}

function hasProcessErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Read the kernel process birth identity used to authenticate detached-group
 * cleanup. Linux exposes an exact boot-scoped start tick in /proc. Darwin's
 * `ps lstart` is its portable process-birth token; PID, PPID, and PGID are
 * captured from the same row and must all continue to match.
 */
export function readOsProcessIdentity(pid: number): ProcessBirthIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxProcessIdentity(pid);
  if (process.platform === "darwin") return readDarwinProcessIdentity(pid);
  return null;
}

function readLinuxProcessIdentity(pid: number): ProcessBirthIdentity | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    // After `(comm)`: state=field 3 (index 0), ppid=4 (1), pgrp=5 (2),
    // and starttime=22 (19). The start tick is unique for this boot.
    if (fields.length <= 19 || !/^\d+$/.test(fields[19])) return null;
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0
      || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return null;
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f-]{16,}$/i.test(bootId)) return null;
    return { pid, parentPid, processGroupId, startToken: `linux:${bootId}:${fields[19]}` };
  } catch {
    return null;
  }
}

function readDarwinProcessIdentity(pid: number): ProcessBirthIdentity | null {
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart="],
      {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      },
    ).trim();
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(output);
    if (!match) return null;
    const observedPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    const startedAt = match[4].trim().replace(/\s+/g, " ");
    if (observedPid !== pid
      || !Number.isSafeInteger(parentPid) || parentPid <= 0
      || !Number.isSafeInteger(processGroupId) || processGroupId <= 0
      || startedAt.length === 0) return null;
    return { pid, parentPid, processGroupId, startToken: `darwin:${startedAt}` };
  } catch {
    return null;
  }
}

async function waitForSettled(waiters: Promise<void>[], timeoutMs: number): Promise<void> {
  if (waiters.length === 0) return;
  await Promise.race([
    Promise.allSettled(waiters).then(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

export function pathsOverlap(left: string[], right: string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (pathScopeMayOverlap(a, b)) return true;
    }
  }
  return false;
}

function pathScopeMayOverlap(left: string, right: string): boolean {
  const a = normalizeRepoPath(left);
  const b = normalizeRepoPath(right);
  if (a === b) return true;
  const aGlob = a.includes("*");
  const bGlob = b.includes("*");
  if (!aGlob && !bGlob) return false;
  const aPrefix = aGlob ? a.slice(0, a.indexOf("*")) : a;
  const bPrefix = bGlob ? b.slice(0, b.indexOf("*")) : b;
  return a.startsWith(bPrefix) || b.startsWith(aPrefix) || aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

export function createAgentTask(role: AgentRole, instructions: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: overrides.id ?? `agent-${crypto.randomBytes(4).toString("hex")}`,
    role,
    instructions,
    inputArtifactIds: overrides.inputArtifactIds ?? [],
    outputSchema: overrides.outputSchema,
    permittedEffects: overrides.permittedEffects ?? [],
    allowedPaths: overrides.allowedPaths ?? [],
    workspace: overrides.workspace ?? "read_only_snapshot",
    modelProfile: overrides.modelProfile ?? DEFAULT_MODEL_PROFILE_BY_ROLE[role],
    dependsOn: overrides.dependsOn ?? [],
    budget: overrides.budget ?? { maxTurns: 4, maxTokens: 16000, timeoutMs: 300_000 },
  };
}

function extractFinalText(stdout: string): string {
  let final = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const message = event.message;
      if (event.type === "message_end" && message?.role === "assistant") {
        for (const part of message.content ?? []) {
          if (part.type === "text") final = part.text;
        }
      }
    } catch {
      final += line + "\n";
    }
  }
  return final.trim() || stdout.trim();
}

export function validateStructuredOutput<T>(task: AgentTask<T>, outputText: string): { ok: true; value?: T; error?: "" } | { ok: false; error: string; value?: undefined } {
  if (!task.outputSchema) return { ok: true };
  const jsonText = outputText.trim().startsWith("{") && outputText.trim().endsWith("}")
    ? outputText.trim()
    : (outputText.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonText) return { ok: false, error: "Structured subagent output missing JSON object." };
  try {
    const parsed = JSON.parse(jsonText);
    if (!Value.Check(task.outputSchema as never, parsed)) {
      return { ok: false, error: "Structured subagent output failed schema validation." };
    }
    return { ok: true, value: parsed as T };
  } catch (err) {
    return { ok: false, error: `Structured subagent output is invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}
