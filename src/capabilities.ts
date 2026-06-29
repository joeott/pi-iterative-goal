/**
 * Capability detection and preflight.
 *
 * Takes a snapshot of all available tools, commands, and MCP servers,
 * then produces prompt-visible capability text that prevents the model
 * from hallucinating unavailable tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type CapabilitySnapshot,
  type CapabilityNamespaces,
  type SubagentBackend,
  type ToolInfo,
  type CommandInfo,
} from "./types.js";

// ── Capability snapshot ─────────────────────────────────────────────

export function takeCapabilitySnapshot(pi: ExtensionAPI): CapabilitySnapshot {
  const allTools: ToolInfo[] = pi.getAllTools().map((t) => ({
    name: t.name,
    description: t.description ?? "",
    source: t.sourceInfo?.source ?? "unknown",
    path: t.sourceInfo?.path,
    origin: t.sourceInfo?.origin,
  }));

  const activeToolNames = pi.getActiveTools();

  const commands: CommandInfo[] = pi.getCommands().map((c) => ({
    name: c.name,
    description: c.description,
    source: c.source,
    sourceInfo: {
      path: c.sourceInfo.path,
      source: c.sourceInfo.source,
      scope: c.sourceInfo.scope as "user" | "project" | "temporary",
      origin: c.sourceInfo.origin as "package" | "top-level",
    },
  }));

  // Detect MCP servers from tool sources
  const mcpServers: string[] = [];
  for (const tool of allTools) {
    if (tool.source === "mcp" && tool.path && !mcpServers.includes(tool.path)) {
      mcpServers.push(tool.path);
    }
  }

  return {
    takenAt: new Date().toISOString(),
    activeTools: activeToolNames,
    allTools,
    commands,
    hasBashTool: allTools.some((t) => t.name === "bash"),
    hasSubagentTool: allTools.some((t) => t.name === "subagent"),
    hasAgentTool: allTools.some((t) => t.name === "Agent"),
    hasMcpTool: allTools.some((t) => t.name === "mcp"),
    mcpServers,
    model: "",
    provider: "",
    awsCli: null,
    hasFilesystem: true,
    hasGit: true,
    hasNetwork: true,
    hasAws: allTools.some((t) => t.name === "goal_aws_cli"),
    hasAwsConfig: false,
    hasAwsSecurityHub: false,
    hasAwsAccessAnalyzer: false,
    hasScannerTools: false,
    hasSandbox: true,
    hasDlpProxy: true,
    hasIpiSanitizer: true,
    hasEvidenceSigner: true,
    cyberCapabilities: [
      "dlp_pre_context_scrub",
      "ipi_untrusted_data_delimiters",
      "ed25519_evidence_attestation",
      "pending_approval_state",
      "cas_unify_nemotron_policy",
    ],
    unavailableCapabilities: [],
    gitFinalization: null,
  };
}

// ── Namespace separation ────────────────────────────────────────────

export function buildNamespaces(snapshot: CapabilitySnapshot): CapabilityNamespaces {
  const builtinTools: string[] = [];
  const extensionTools: string[] = [];
  const sdkTools: string[] = [];
  const skills: string[] = [];

  for (const tool of snapshot.allTools) {
    if (tool.source === "builtin") builtinTools.push(tool.name);
    else if (tool.source === "sdk") sdkTools.push(tool.name);
    else extensionTools.push(tool.name);
  }

  // Skills come from commands with source "skill"
  for (const cmd of snapshot.commands) {
    if (cmd.source === "skill") skills.push(cmd.name);
  }

  return {
    builtinTools,
    extensionTools,
    sdkTools,
    commands: snapshot.commands.filter((c) => c.source === "extension").map((c) => c.name),
    skills,
    mcpServers: snapshot.mcpServers,
  };
}

// ── Subagent backend detection ──────────────────────────────────────

export function detectSubagentBackend(
  pi: ExtensionAPI,
  snapshot: CapabilitySnapshot,
): SubagentBackend {
  const toolNames = snapshot.allTools.map((t) => t.name);
  if (toolNames.includes("subagent")) return { kind: "tool", toolName: "subagent" };
  if (toolNames.includes("Agent")) return { kind: "tool", toolName: "Agent" };

  const commands = snapshot.commands;
  const maybe = commands.find((c) =>
    /subagent|agent|parallel|scout|review/i.test(c.name),
  );
  if (maybe) return { kind: "command", commandName: maybe.name };

  return { kind: "none" };
}

// ── Prompt-visible capability text ──────────────────────────────────

export function renderCapabilitySummary(
  snapshot: CapabilitySnapshot,
  subagentBackend: SubagentBackend,
): string {
  const ns = buildNamespaces(snapshot);
  const lines: string[] = [];

  lines.push("[CAPABILITY PREFLIGHT]");
  lines.push("Available tools this turn:");

  const checkmark = (available: boolean) => (available ? "yes" : "no");

  lines.push(`- read: ${checkmark(ns.builtinTools.includes("read"))}`);
  lines.push(`- write: ${checkmark(ns.builtinTools.includes("write"))}`);
  lines.push(`- edit: ${checkmark(ns.builtinTools.includes("edit"))}`);
  lines.push(`- bash: ${checkmark(snapshot.hasBashTool)}`);
  lines.push(
    `- subagent: ${checkmark(snapshot.hasSubagentTool)}`,
  );
  lines.push(
    `- Agent: ${checkmark(snapshot.hasAgentTool)}`,
  );
  lines.push(
    `- mcp: ${
      snapshot.mcpServers.length > 0
        ? snapshot.mcpServers.join(", ")
        : "no servers detected"
    }`,
  );
  if (snapshot.awsCli?.enabled) {
    lines.push(
      `- aws-cli: ${
        snapshot.awsCli.cliAvailable
          ? `yes (profile=${snapshot.awsCli.resolvedProfile ?? "unresolved"}, region=${snapshot.awsCli.resolvedRegion ?? "unknown"})`
          : "no"
      }`,
    );
    lines.push(
      `- session-manager-plugin: ${snapshot.awsCli.sessionManagerPluginAvailable ? "yes" : "no"}`,
    );
  }
  lines.push(`- filesystem: ${checkmark(snapshot.hasFilesystem !== false)}`);
  lines.push(`- git: ${checkmark(snapshot.hasGit !== false)}`);
  lines.push(`- network: ${checkmark(snapshot.hasNetwork !== false)}`);
  lines.push(`- sandbox: ${checkmark(snapshot.hasSandbox !== false)}`);
  lines.push(`- dlp-proxy: ${checkmark(snapshot.hasDlpProxy !== false)}`);
  lines.push(`- ipi-sanitizer: ${checkmark(snapshot.hasIpiSanitizer !== false)}`);
  lines.push(`- evidence-signer: ${checkmark(snapshot.hasEvidenceSigner !== false)}`);
  const cyberCapabilities = snapshot.cyberCapabilities ?? [];
  const unavailableCapabilities = snapshot.unavailableCapabilities ?? [];
  if (cyberCapabilities.length > 0) {
    lines.push(`- Cyber controls: ${cyberCapabilities.join(", ")}`);
  }
  if (unavailableCapabilities.length > 0) {
    lines.push(`- Unavailable controls: ${unavailableCapabilities.join(", ")}`);
  }
  if (snapshot.gitFinalization?.enabled) {
    lines.push(
      `- git-finalization: yes (commit=${snapshot.gitFinalization.allowCommit ? "yes" : "no"}, push=${snapshot.gitFinalization.allowPush ? "yes" : "no"}, pr=${snapshot.gitFinalization.allowPR ? "yes" : "no"})`,
    );
    lines.push(
      `- gh: ${snapshot.gitFinalization.ghAvailable ? (snapshot.gitFinalization.ghAuthenticated ? "yes (authenticated)" : "installed, auth missing") : "no"}`,
    );
  }
  lines.push(
    "- CAS/Unify OCR policy: current route is Unify self-hosted Nemotron / unify_nemotron resolver projection; Paddle/CPU/SQS OCR routes are deprecated for current operations.",
  );

  if (ns.extensionTools.length > 0) {
    lines.push(`- Extension tools: ${ns.extensionTools.join(", ")}`);
  }

  lines.push("");
  lines.push(
    `Subagent backend: ${subagentBackend.kind}${
      subagentBackend.kind !== "none"
        ? ` (${JSON.stringify(subagentBackend)})`
        : ". Run scout work in this session. Do not attempt 'subagent parallel'."
    }`,
  );
  lines.push("");

  lines.push("Known MCP servers:");
  if (snapshot.mcpServers.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of snapshot.mcpServers) {
      lines.push(`  - ${s}`);
    }
  }
  lines.push("Not MCP servers:");
  lines.push("  - pi-subagents is an extension/skill package, NOT an MCP server.");
  lines.push("");

  lines.push("Rules:");
  lines.push(
    "- Use only tools listed as available above.",
  );
  if (!snapshot.hasBashTool) {
    lines.push(
      "- Do NOT call bash; use goal_shell if available, or describe commands for extension execution.",
    );
  }
  if (!snapshot.hasSubagentTool && !snapshot.hasAgentTool) {
    lines.push(
      "- Do NOT call subagent or Agent; use single-agent scout fallback.",
    );
  }
  lines.push(
    "- Do NOT call MCP servers not listed in 'Known MCP servers' above.",
  );
  if (snapshot.awsCli?.enabled) {
    lines.push(
      "- Use goal_aws_cli for AWS CLI operations. Do not route AWS mutations through bash or goal_shell.",
    );
  }
  if (snapshot.gitFinalization?.enabled) {
    lines.push(
      "- Use goal_git for git add/commit/push/PR actions. Do not route git finalization through bash or goal_shell.",
    );
  }
  lines.push(
    "- Do NOT invent tools (like iterative_goal_update_plan). Use registered tools only.",
  );

  return lines.join("\n");
}
