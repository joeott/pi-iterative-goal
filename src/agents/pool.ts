import { spawn } from "node:child_process";
import * as crypto from "node:crypto";

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

  constructor(private readonly cwd: string) {}

  async submit<T>(task: AgentTask<T>, signal?: AbortSignal): Promise<AgentResult<T>> {
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
    }
    if (task.modelProfile) args.push("--model", task.modelProfile);
    args.push(prompt);

    return await new Promise<AgentResult<T>>((resolve) => {
      const proc = spawn("pi", args, { cwd: this.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(task.id, proc);
      let stdout = "";
      let stderr = "";
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
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const message = event.message;
            if (event.type === "message_end" && message?.role === "assistant") {
              usage.turns += 1;
              usage.input += message.usage?.input ?? 0;
              usage.output += message.usage?.output ?? 0;
              usage.cacheRead += message.usage?.cacheRead ?? 0;
              usage.cacheWrite += message.usage?.cacheWrite ?? 0;
              usage.cost += message.usage?.cost?.total ?? 0;
            }
          } catch {
            // Preserve raw output even if the subprocess is not in JSON mode.
          }
        }
      });
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.running.delete(task.id);
        const outputText = extractFinalText(stdout);
        resolve({
          taskId: task.id,
          role: task.role,
          ok: code === 0,
          outputText,
          exitCode: code,
          stderr,
          usage,
        });
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.running.delete(task.id);
        resolve({
          taskId: task.id,
          role: task.role,
          ok: false,
          outputText: "",
          exitCode: null,
          stderr: err.message,
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
  }
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
