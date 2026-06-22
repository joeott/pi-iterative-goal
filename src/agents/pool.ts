import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { normalizeRepoPath } from "../domain/path-scope.js";

export type AgentRole =
  | "Scout"
  | "Requirements analyst"
  | "Planner"
  | "Implementer"
  | "Test engineer"
  | "Security reviewer"
  | "Architecture/Ousterhout advisor"
  | "Documentation reviewer"
  | "Release reviewer"
  | "Integrator";

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
  patch?: string;
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
  cancel(taskId: string): Promise<void>;
}

export class PiSubprocessAgentPool implements AgentPool {
  private readonly running = new Map<string, ReturnType<typeof spawn>>();
  private readonly activeWriteScopes = new Map<string, string[]>();

  constructor(private readonly cwd: string) {}

  async submit<T>(task: AgentTask<T>, signal?: AbortSignal): Promise<AgentResult<T>> {
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
      const proc = spawn("pi", args, { cwd: runCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
        const patch = workspace?.capturePatch() ?? "";
        const workspacePath = workspace?.path;
        workspace?.cleanup();
        const outputText = extractFinalText(stdout);
        const structured = validateStructuredOutput<T>(task, outputText);
        resolve({
          taskId: task.id,
          role: task.role,
          ok: code === 0 && structured.ok,
          outputText: patch ? `${outputText}\n\n[ISOLATED_WORKTREE_PATCH]\n${patch}`.trim() : outputText,
          structuredOutput: structured.value,
          exitCode: code === 0 && !structured.ok ? 1 : code,
          stderr: [stderr, structured.error].filter(Boolean).join("\n"),
          workspacePath,
          patch,
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
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? 2, tasks.length || 1));
    let next = 0;
    await Promise.all(new Array(concurrency).fill(null).map(async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await this.submit<T>(tasks[index], options?.signal);
      }
    }));
    return results;
  }

  async cancel(taskId: string): Promise<void> {
    const proc = this.running.get(taskId);
    if (proc) proc.kill("SIGTERM");
    this.activeWriteScopes.delete(taskId);
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
    "Return concise structured findings. Do not claim success without evidence.",
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

export interface IsolatedWorkspace {
  path: string;
  capturePatch(): string;
  cleanup(): void;
}

export function prepareIsolatedWorktree(repoRoot: string, taskId: string): IsolatedWorkspace {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
  const safeId = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  const workspacePath = path.join(os.tmpdir(), `pi-ig-agent-${safeId}-${crypto.randomBytes(4).toString("hex")}`);
  execFileSync("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
  registerWorktreeForCleanup(repoRoot, workspacePath);
  return {
    path: workspacePath,
    capturePatch() {
      try {
        return execFileSync("git", ["diff", "--binary"], { cwd: workspacePath, encoding: "utf8", timeout: 30_000 }).trim();
      } catch {
        return "";
      }
    },
    cleanup() {
      try {
        execFileSync("git", ["worktree", "remove", "--force", workspacePath], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
      } catch {
        try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch {}
      }
      unregisterWorktreeForCleanup(repoRoot, workspacePath);
    },
  };
}

const pendingWorktreeCleanups = new Map<string, string>();
let cleanupHandlersRegistered = false;

function registerWorktreeForCleanup(repoRoot: string, workspacePath: string): void {
  pendingWorktreeCleanups.set(workspacePath, repoRoot);
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  const cleanupAll = () => {
    for (const [workspace, root] of pendingWorktreeCleanups.entries()) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", workspace], { cwd: root, stdio: "ignore", timeout: 30_000 });
      } catch {
        try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
      }
      pendingWorktreeCleanups.delete(workspace);
    }
  };
  process.once("beforeExit", cleanupAll);
  process.once("exit", cleanupAll);
}

function unregisterWorktreeForCleanup(_repoRoot: string, workspacePath: string): void {
  pendingWorktreeCleanups.delete(workspacePath);
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
