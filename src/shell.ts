/**
 * goal_shell - Safe shell execution abstraction.
 *
 * Backed by pi.exec() with allowlists/blocklists and safety checks.
 * Registered as a Pi tool so the LLM can call it even when the built-in
 * bash tool is unavailable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { checkCommand, isSafeReadOnly, isDestructive } from "./safety.js";
import { shouldBlockAwsShellCommand } from "./aws-cli.js";
import { shouldBlockGitShellCommand } from "./git.js";
import type { AwsCliConfig, FinalizationPolicy } from "./types.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";

function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [goal_shell] ${msg}\n`,
    );
  } catch {}
}

const GoalShellParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (defaults to project root)" }),
  ),
  purpose: Type.Optional(
    Type.String({
      description: "Brief description of why this command is needed",
    }),
  ),
  allowDestructive: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow potentially destructive commands (default: false)",
      default: false,
    }),
  ),
});

export interface GoalShellDetails {
  exitCode: number | null;
  killed: boolean;
  truncated: boolean;
  allowed: boolean;
  command: string;
  cwd: string;
  purpose?: string;
  safetyCheckResult?: string;
}

export function registerGoalShellTool(
  pi: ExtensionAPI,
  getAwsCliConfig?: () => AwsCliConfig | null,
  getFinalizationPolicy?: () => FinalizationPolicy | null,
): void {
  pi.registerTool({
    name: "goal_shell",
    label: "Goal Shell",
    description: [
      "Run a shell command with safety allowlists. Use this instead of bash",
      "when bash may be unavailable. Destructive commands require explicit",
      "allowDestructive=true and operator approval.",
    ].join(" "),
    promptSnippet: "Run allowlisted shell commands for the iterative goal loop",
    promptGuidelines: [
      "Use goal_shell for shell commands when the bash tool may be unavailable. Prefer goal_shell over bash for all goal-loop operations so they are tracked in the events log.",
    ],
    parameters: GoalShellParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = params.command as string;
      const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
      const purpose = params.purpose as string | undefined;
      const allowDestructive = (params.allowDestructive as boolean) ?? false;

      log(`exec: ${command} (cwd=${cwd}, destructive=${allowDestructive})`);

      // Safety check
      const safetyResult = checkCommand(command, allowDestructive);
      if (!safetyResult.allowed) {
        log(`BLOCKED: ${safetyResult.reason}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `SAFETY BLOCK: ${safetyResult.reason}\n\nCommand: ${command}`,
            },
          ],
          details: {
            exitCode: null,
            killed: false,
            truncated: false,
            allowed: false,
            command,
            cwd,
            purpose,
            safetyCheckResult: safetyResult.reason,
          } satisfies GoalShellDetails,
        };
      }

      const awsShellBlock = shouldBlockAwsShellCommand(command, getAwsCliConfig?.() ?? {
        enabled: false,
        defaultRegion: "us-east-1",
        profileResolutionOrder: ["explicit", "env", "unify", "unify-old"],
        requireSessionManagerPlugin: true,
        allowMutatingFamilies: [],
        preflight: null,
      });
      if (awsShellBlock) {
        log(`BLOCKED AWS SHELL: ${awsShellBlock}`);
        return {
          content: [{ type: "text" as const, text: `SAFETY BLOCK: ${awsShellBlock}` }],
          details: {
            exitCode: null,
            killed: false,
            truncated: false,
            allowed: false,
            command,
            cwd,
            purpose,
            safetyCheckResult: awsShellBlock,
          } satisfies GoalShellDetails,
        };
      }
      const gitShellBlock = shouldBlockGitShellCommand(command, getFinalizationPolicy?.() ?? {
        allowGitFinalization: false,
        allowCommit: false,
        allowPush: false,
        allowPR: false,
        fallback: "patch",
      });
      if (gitShellBlock) {
        log(`BLOCKED GIT SHELL: ${gitShellBlock}`);
        return {
          content: [{ type: "text" as const, text: `SAFETY BLOCK: ${gitShellBlock}` }],
          details: {
            exitCode: null,
            killed: false,
            truncated: false,
            allowed: false,
            command,
            cwd,
            purpose,
            safetyCheckResult: gitShellBlock,
          } satisfies GoalShellDetails,
        };
      }

      try {
        const result = await pi.exec(command, [], {
          cwd,
          signal: signal ?? undefined,
          timeout: 120_000,
        });

        const truncated = result.stdout.length > 50000 ||
          result.stderr.length > 50000;
        const stdoutDisplay = result.stdout.slice(0, 50000);
        const stderrDisplay = result.stderr.slice(0, 50000);

        let text = "";
        if (result.code === 0) {
          text = stdoutDisplay || "(no output)";
        } else {
          text = [
            `Exit code: ${result.code}`,
            stdoutDisplay ? `STDOUT:\n${stdoutDisplay}` : "",
            stderrDisplay ? `STDERR:\n${stderrDisplay}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
        }

        if (truncated) {
          text +=
            "\n\n[Output truncated at 50KB. Use goal_shell with purpose to log the command.]";
        }

        return {
          content: [{ type: "text" as const, text }],
          details: {
            exitCode: result.code,
            killed: result.killed ?? false,
            truncated,
            allowed: true,
            command,
            cwd,
            purpose,
          } satisfies GoalShellDetails,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERROR: ${msg}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Shell execution failed: ${msg}`,
            },
          ],
          details: {
            exitCode: null,
            killed: false,
            truncated: false,
            allowed: true,
            command,
            cwd,
            purpose,
            safetyCheckResult: msg,
          } satisfies GoalShellDetails,
          isError: true,
        };
      }
    },
  });
}
