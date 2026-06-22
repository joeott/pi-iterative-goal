/**
 * Subagent adapter - detects actual available subagent mechanisms
 * and provides fallbacks. Never confuses MCP servers with subagent packages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type SubagentBackend, type CapabilitySnapshot, type ToolInfo } from "./types.js";
import { detectSubagentBackend } from "./capabilities.js";
import { PiSubprocessAgentPool, createAgentTask, type AgentRole } from "./agents/pool.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [subagents] ${msg}\n`);
  } catch {}
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Adapter tool ────────────────────────────────────────────────────

const GoalSubagentParams = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent role/name to invoke",
  })),
  role: Type.Optional(StringEnum([
    "Scout",
    "Requirements analyst",
    "Planner",
    "Implementer",
    "Test engineer",
    "Security reviewer",
    "Architecture/Ousterhout advisor",
    "Documentation reviewer",
    "Release reviewer",
    "Integrator",
  ] as const, {
    description: "Typed subagent role. Defaults to Scout.",
    default: "Scout",
  })),
  task: Type.String({ description: "Task to delegate to the subagent" }),
  allowedPaths: Type.Optional(Type.Array(Type.String(), {
    description: "Required for writer roles; repository-relative paths the subagent may modify in its isolated worktree.",
  })),
  model: Type.Optional(Type.String({
    description: "Optional Pi model ID to pass to the subprocess backend",
  })),
  mode: Type.Optional(
    StringEnum(["single", "parallel", "chain"] as const, {
      description: "Execution mode. Default: single.",
      default: "single",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

export interface GoalSubagentDetails {
  backendKind: SubagentBackend["kind"];
  backendDetail: string;
  fallback: boolean;
  result: string;
}

export function registerGoalSubagentTool(
  pi: ExtensionAPI,
  getSnapshot: () => CapabilitySnapshot | null,
): void {
  pi.registerTool({
    name: "goal_subagent",
    label: "Goal Subagent",
    description: [
      "Delegate scouting/research tasks to subagents when a subagent backend is available.",
      "When no backend is detected, falls back to single-agent scouting in the current session.",
      "Do not call 'subagent' or 'Agent' tools directly; use goal_subagent.",
    ].join(" "),
    promptSnippet: "Run subagent tasks with automatic backend detection and fallback",
    promptGuidelines: [
      "Use goal_subagent for scouting/research delegation instead of calling subagent or Agent tools directly. The goal_subagent tool automatically detects available backends and handles fallback.",
    ],
    parameters: GoalSubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = getSnapshot();
      const backend = snapshot
        ? detectSubagentBackend(pi, snapshot)
        : ({ kind: "none" as const });

      const role = (params.role as AgentRole | undefined) ?? "Scout";
      const agent = String(params.agent ?? role);
      const task = String(params.task ?? "");
      const allowedPaths = Array.isArray(params.allowedPaths) ? params.allowedPaths as string[] : [];
      const writerRole = role === "Implementer" || role === "Integrator";
      log(`goal_subagent called: agent=${agent}, role=${role}, backend=${backend.kind}`);

      if (writerRole && allowedPaths.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "POLICY BLOCK: writer subagents require explicit allowedPaths and an isolated worktree lease.",
          }],
          details: {
            backendKind: "none",
            backendDetail: "writer-subagents-require-allowed-paths",
            fallback: true,
            result: "policy-blocked",
          } satisfies GoalSubagentDetails,
          isError: true,
        };
      }

      if (!commandExists("pi")) {
        // Fallback message
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "[SUBAGENT BACKEND: NONE]",
                "",
                `Task that would have been delegated to '${agent}': ${task}`,
                "",
                "No subagent backend is available. Perform this scouting/research work",
                "in the current session using single-agent scouting.",
                "",
                "Use read, grep, find, ls, and goal_shell to explore the codebase.",
              ].join("\n"),
            },
          ],
          details: {
            backendKind: "none",
            backendDetail: "No subagent tool, agent tool, or command detected",
            fallback: true,
            result: "single-agent-fallback",
          } satisfies GoalSubagentDetails,
        };
      }

      const pool = new PiSubprocessAgentPool((params.cwd as string | undefined) ?? ctx.cwd);
      const agentTask = createAgentTask(role, task, {
        modelProfile: typeof params.model === "string" ? params.model : "",
        workspace: writerRole ? "isolated_worktree" : "read_only_snapshot",
        permittedEffects: writerRole ? ["fs.write", "process.exec"] : [],
        allowedPaths,
        budget: { maxTurns: 4, maxTokens: 16000, timeoutMs: 300_000 },
      });
      const result = await pool.submit(agentTask, _signal ?? undefined);

      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? result.outputText || "(subagent completed with no text output)"
              : [
                  `[SUBAGENT FAILED: ${result.exitCode ?? "spawn-error"}]`,
                  result.stderr || result.outputText || "No subprocess output.",
                  "",
                  "Fallback: perform this work in the current session.",
                ].join("\n"),
          },
        ],
        details: {
          backendKind: "command",
          backendDetail: "PiSubprocessAgentPool",
          fallback: !result.ok,
          result: JSON.stringify(result),
        } satisfies GoalSubagentDetails,
        isError: !result.ok,
      };
    },
  });
}
