import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { Value } from "typebox/value";
import { normalizeRepoPath } from "../domain/path-scope.js";
import { prepareIsolatedWorktree } from "../workspace/worktrees.js";
import type { IsolatedWorkspace } from "../workspace/worktrees.js";
import type { AgentRole } from "./roles.js";

export type { AgentRole } from "./roles.js";
// The isolated-worktree primitive lives in src/workspace/worktrees.ts (C4
// promotion, §6.6) — re-exported here so existing pool consumers and tests
// keep a stable import path.
export { prepareIsolatedWorktree } from "../workspace/worktrees.js";
export type { IsolatedWorkspace } from "../workspace/worktrees.js";

/** Swarm fan-out band (§5.1): default 4, hard cap 8 — the single source. */
export const DEFAULT_SWARM_CONCURRENCY = 4;
export const MAX_SWARM_CONCURRENCY = 8;

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
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
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
}

export class PiSubprocessAgentPool implements AgentPool {
  private readonly running = new Map<string, ReturnType<typeof spawn>>();
  // Cross-call write-scope registry: lives as long as the pool, so a writer
  // admitted by an earlier goal_subagent call still blocks colliding scopes.
  private readonly activeWriteScopes = new Map<string, string[]>();
  private readonly cancelledTasks = new Set<string>();
  private readonly queuedTasks = new Set<string>();
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly cwd: string, options: PiSubprocessAgentPoolOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async submit<T>(task: AgentTask<T>, signal?: AbortSignal): Promise<AgentResult<T>> {
    // Cancel-before-admission guard: a task cancelled while queued is never
    // executed — the ledger may say cancelled only because nothing ran.
    if (this.cancelledTasks.has(task.id)) {
      return failedResult(task, `Task ${task.id} was cancelled before admission; it never executed.`);
    }
    let workspace: IsolatedWorkspace | null = null;
    let runCwd = this.cwd;
    if (task.workspace === "isolated_worktree") {
      const conflict = this.findWriteScopeConflict(task);
      if (conflict) return failedResult(task, conflict);
      this.activeWriteScopes.set(task.id, task.allowedPaths);
      try {
        workspace = prepareIsolatedWorktree(this.cwd, task.id);
        runCwd = workspace.path;
      } catch (err) {
        this.activeWriteScopes.delete(task.id);
        return failedResult(task, err instanceof Error ? err.message : String(err));
      }
    }

    const args = buildPiSubprocessArgs(task);

    return await new Promise<AgentResult<T>>((resolve) => {
      const proc = this.spawnImpl("pi", args, { cwd: runCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(task.id, proc);
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
      }, task.budget.timeoutMs);
      timeout.unref();

      const abort = () => proc.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });

      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        const lines = (stdoutLineBuffer + text).split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines) accumulateUsageFromJsonLine(line, usage);
      });
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.running.delete(task.id);
        this.activeWriteScopes.delete(task.id);
        // Capture failure is NOT "no changes" (C4-ADV-011): capturePatch
        // throws on git error; the reader path degrades to null and the
        // merge layer rejects null instead of verifying vanished work.
        let patch: string | null = null;
        try {
          patch = workspace?.capturePatch() ?? null;
        } catch {
          patch = null;
        }
        const workspacePath = workspace?.path;
        workspace?.cleanup();
        const outputText = extractFinalText(stdout);
        const structured = validateStructuredOutput<T>(task, outputText);
        // Schema degradation: a validation failure never discards outputText —
        // prose reaches the supervisor with a validation note in stderr and the
        // result marked degraded instead of failed (C1-OUS-002 / C1-ADV-007).
        const degraded = code === 0 && !structured.ok;
        resolve({
          taskId: task.id,
          role: task.role,
          ok: code === 0,
          outputText: patch ? `${outputText}\n\n[ISOLATED_WORKTREE_PATCH]\n${patch}`.trim() : outputText,
          structuredOutput: structured.value,
          exitCode: code,
          stderr: [stderr, structured.error].filter(Boolean).join("\n"),
          workspacePath,
          patch,
          ...(degraded ? { degraded: true } : {}),
          usage,
        });
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.running.delete(task.id);
        this.activeWriteScopes.delete(task.id);
        const workspacePath = workspace?.path;
        workspace?.cleanup();
        resolve({
          taskId: task.id,
          role: task.role,
          ok: false,
          outputText: "",
          exitCode: null,
          stderr: err.message,
          workspacePath,
          usage,
        });
      });
    });
  }

  async map<T>(tasks: AgentTask<T>[], options?: { concurrency?: number; signal?: AbortSignal }): Promise<AgentResult<T>[]> {
    const results: AgentResult<T>[] = new Array(tasks.length);
    // Default 4, hard cap 8 (§5.1): beyond ~8 parallel specialists,
    // coordination overhead and token cost dominate.
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? DEFAULT_SWARM_CONCURRENCY, MAX_SWARM_CONCURRENCY, tasks.length || 1));
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
    const proc = this.running.get(taskId);
    if (proc) {
      this.cancelledTasks.add(taskId);
      proc.kill("SIGTERM");
      this.activeWriteScopes.delete(taskId);
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
    for (const [taskId, proc] of this.running.entries()) {
      this.cancelledTasks.add(taskId);
      proc.kill("SIGTERM");
    }
    this.running.clear();
    this.activeWriteScopes.clear();
    this.queuedTasks.clear();
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
}

function accumulateUsageFromJsonLine(
  line: string,
  usage: AgentResult["usage"],
): void {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const message = event.message;
    if (message?.usage) {
      usage.input += message.usage.input ?? 0;
      usage.output += message.usage.output ?? 0;
      usage.cacheRead += message.usage.cacheRead ?? 0;
      usage.cacheWrite += message.usage.cacheWrite ?? 0;
      usage.cost += message.usage.cost?.total ?? 0;
    }
    if (event.type === "message_end" && message?.role === "assistant") {
      usage.turns += 1;
    }
  } catch {
    // Preserve raw output even if the subprocess emits non-JSON lines.
  }
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

  const args = ["--mode", "json", "-p", "--no-session"];
  if (task.workspace === "read_only_snapshot") {
    args.push("--tools", "read,grep,find,ls");
  } else {
    args.push("--tools", "read,grep,find,ls,edit,write,bash");
  }
  if (task.modelProfile) args.push("--model", task.modelProfile);
  args.push(prompt);
  return args;
}

function failedResult<T>(task: AgentTask<T>, stderr: string): AgentResult<T> {
  return {
    taskId: task.id,
    role: task.role,
    ok: false,
    outputText: "",
    exitCode: null,
    stderr,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
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
    modelProfile: overrides.modelProfile ?? "",
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
