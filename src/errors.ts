/**
 * Error classifier and recovery transitions.
 *
 * Detects known Pi error patterns and maps them to recovery actions.
 * Never stops the loop; all errors are recoverable cycle events.
 */

import {
  type ErrorKind,
  type IterativeGoalError,
  type Phase,
} from "./types.js";

// ── Classification ──────────────────────────────────────────────────

export function classifyError(rawText: string): ErrorKind {
  if (/Tool .* not found/i.test(rawText)) return "tool_missing";
  if (/No endpoints found that support tool use/i.test(rawText)) {
    return "provider_tool_route_incompatible";
  }
  if (/Server .* not found/i.test(rawText) && /mcp/i.test(rawText)) {
    return "mcp_server_missing";
  }
  if (/ModuleNotFoundError/i.test(rawText)) return "dependency_missing";
  if (/fatal: .*worktree/i.test(rawText)) return "worktree_conflict";
  if (/dirty|uncommitted/i.test(rawText)) return "dirty_worktree";
  if (/permission denied|forbidden|unauthorized/i.test(rawText)) {
    return "credential_or_permission";
  }
  if (/CI|test.*fail|build.*fail/i.test(rawText)) return "ci_failure";
  return "unknown";
}

// ── Missing tool extraction ─────────────────────────────────────────

export function extractMissingTool(rawText: string): string | undefined {
  const match = rawText.match(
    /Tool\s+["']?(\w+)["']?\s+not found/i,
  );
  return match?.[1]?.toLowerCase() ?? undefined;
}

// ── Missing MCP server extraction ───────────────────────────────────

export function extractMissingMcpServer(rawText: string): string | undefined {
  const match = rawText.match(
    /[Ss]erver\s+["']?([^"'\s]+)["']?\s+not found/i,
  );
  return match?.[1] ?? undefined;
}

// ── Recovery table ──────────────────────────────────────────────────

/** Returns recovery action text and whether model change is needed */
export function getRecoveryAction(
  kind: ErrorKind,
  missingTool?: string,
): {
  action: string;
  requiresModelSwitch: boolean;
  continuePhase: boolean;
} {
  switch (kind) {
    case "tool_missing": {
      if (missingTool === "bash") {
        return {
          action:
            "Use goal_shell / pi.exec; update prompt inventory; continue same phase.",
          requiresModelSwitch: false,
          continuePhase: true,
        };
      }
      if (missingTool === "subagent" || missingTool === "Agent") {
        return {
          action:
            "Use single-agent fallback; mark subagent unavailable; continue Research.",
          requiresModelSwitch: false,
          continuePhase: true,
        };
      }
      return {
        action: `Tool '${missingTool ?? "unknown"}' missing. Use extension fallback if available; continue.`,
        requiresModelSwitch: false,
        continuePhase: true,
      };
    }

    case "mcp_server_missing":
      return {
        action:
          "Remove server from MCP plan; use extension/skill namespace; continue.",
        requiresModelSwitch: false,
        continuePhase: true,
      };

    case "provider_tool_route_incompatible":
      return {
        action:
          "Switch model via pi.setModel(); re-run tool probe; retry phase.",
        requiresModelSwitch: true,
        continuePhase: false,
      };

    case "dependency_missing":
      return {
        action:
          "If allowed and project-local, install/sync; otherwise create blocker and continue Validate/Evaluate.",
        requiresModelSwitch: false,
        continuePhase: true,
      };

    case "dirty_worktree":
      return {
        action:
          "Do not mutate; choose clean locked worktree or ask evaluator for recovery.",
        requiresModelSwitch: false,
        continuePhase: true,
      };

    case "worktree_conflict":
      return {
        action:
          "Use existing main worktree for merge, detached worktree for edits, or re-checkout detached head.",
        requiresModelSwitch: false,
        continuePhase: true,
      };

    case "ci_failure":
      return {
        action: "Loop back to Research with CI logs.",
        requiresModelSwitch: false,
        continuePhase: false,
      };

    case "credential_or_permission":
      return {
        action:
          "Record blocker; do not retry privileged operations; continue with safe phases.",
        requiresModelSwitch: false,
        continuePhase: true,
      };

    case "unknown":
    default:
      return {
        action: "Summarize, evaluate, then continue Research.",
        requiresModelSwitch: false,
        continuePhase: true,
      };
  }
}

// ── Full error record builder ───────────────────────────────────────

export function createErrorRecord(
  rawText: string,
  phase: Phase,
  cycle: number,
): IterativeGoalError {
  const kind = classifyError(rawText);
  const missingTool = extractMissingTool(rawText);
  const recovery = getRecoveryAction(kind, missingTool);

  return {
    timestamp: new Date().toISOString(),
    phase,
    cycle,
    kind,
    rawText: rawText.slice(0, 500),
    missingTool,
    recoveryAction: recovery.action,
    resolved: false,
  };
}
