/**
 * Subagent adapter - detects actual available subagent mechanisms
 * and provides fallbacks. Never confuses MCP servers with subagent packages.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { type SubagentBackend, type CapabilitySnapshot, type ToolInfo } from "./types.js";
import { detectSubagentBackend } from "./capabilities.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [subagents] ${msg}\n`);
  } catch {}
}

// ── Adapter tool ────────────────────────────────────────────────────

const GoalSubagentParams = Type.Object({
  agent: Type.String({
    description: "Agent name to invoke (only used when a tool/command backend is available)",
  }),
  task: Type.String({ description: "Task to delegate to the subagent" }),
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

      log(`goal_subagent called: agent=${params.agent}, backend=${backend.kind}`);

      if (backend.kind === "none") {
        // Fallback message
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "[SUBAGENT BACKEND: NONE]",
                "",
                `Task that would have been delegated to '${params.agent}': ${params.task}`,
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

      // Backend exists - provide the correct invocation syntax
      const invocationHint =
        backend.kind === "tool"
          ? `Use the '${backend.toolName}' tool with agent='${params.agent}' and task describing what to do.`
          : `Use the '${backend.commandName}' command with the task: ${params.task}`;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `[SUBAGENT BACKEND: ${backend.kind.toUpperCase()}]`,
              `Backend: ${JSON.stringify(backend)}`,
              `Agent: ${params.agent}`,
              `Task: ${params.task}`,
              "",
              invocationHint,
              "",
              "Alternatively, perform single-agent scouting if the backend is unreliable.",
            ].join("\n"),
          },
        ],
        details: {
          backendKind: backend.kind,
          backendDetail: JSON.stringify(backend),
          fallback: false,
          result: `backend-detected:${backend.kind}`,
        } satisfies GoalSubagentDetails,
      };
    },
  });
}
