/**
 * Core types for the iterative-goal Pi extension.
 * Autonomous supervisor loop that never stops until an external evaluator
 * returns goal_met: true.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ── Phase definitions ───────────────────────────────────────────────

export const PHASE_ORDER = ["research", "plan", "implement", "validate"] as const;
export type Phase = (typeof PHASE_ORDER)[number];

// ── Error classification ────────────────────────────────────────────

export const ErrorKindSchema = StringEnum(
  [
    "tool_missing",
    "provider_tool_route_incompatible",
    "mcp_server_missing",
    "dependency_missing",
    "worktree_conflict",
    "dirty_worktree",
    "credential_or_permission",
    "ci_failure",
    "unknown",
  ] as const,
);

export type ErrorKind = Static<typeof ErrorKindSchema>;

export interface IterativeGoalError {
  timestamp: string;
  phase: Phase;
  cycle: number;
  kind: ErrorKind;
  rawText: string;
  missingTool?: string;
  recoveryAction: string;
  resolved: boolean;
}

// ── Capability snapshot ──────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  description: string;
  source: string; // "builtin" | "sdk" | extension source metadata
  path?: string;
  origin?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string; // extension metadata source
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
  };
}

export interface ModelCapabilityProfile {
  provider: string;
  model: string;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  knownBadForGoalLoop?: boolean;
  lastProbeAt: string;
}

export interface CapabilitySnapshot {
  takenAt: string;
  activeTools: string[];
  allTools: ToolInfo[];
  commands: CommandInfo[];
  hasBashTool: boolean;
  hasSubagentTool: boolean;
  hasAgentTool: boolean;
  hasMcpTool: boolean;
  mcpServers: string[];
  model: string;
  provider: string;
}

export interface CapabilityNamespaces {
  builtinTools: string[];
  extensionTools: string[];
  sdkTools: string[];
  commands: string[];
  skills: string[];
  mcpServers: string[];
}

// ── Subagent backend ─────────────────────────────────────────────────

export type SubagentBackend =
  | { kind: "tool"; toolName: "subagent" }
  | { kind: "tool"; toolName: "Agent" }
  | { kind: "command"; commandName: string }
  | { kind: "none" };

// ── Evaluator verdict ────────────────────────────────────────────────

export interface EvaluatorVerdict {
  goal_met: boolean;
  confidence: number; // 0-1
  completion_blockers: string[];
  accepted_evidence: string[];
  rejected_evidence: string[];
  remaining_work: Array<{
    priority: "critical" | "high" | "medium" | "low";
    description: string;
  }>;
  next_cycle_directive: {
    focus: Phase | "capability_repair";
    reason: string;
  };
  safety_notes: string[];
}

export const EvaluatorVerdictSchema = Type.Object({
  goal_met: Type.Boolean(),
  confidence: Type.Number(),
  completion_blockers: Type.Array(Type.String()),
  accepted_evidence: Type.Array(Type.String()),
  rejected_evidence: Type.Array(Type.String()),
  remaining_work: Type.Array(
    Type.Object({
      priority: StringEnum(["critical", "high", "medium", "low"] as const),
      description: Type.String(),
    }),
  ),
  next_cycle_directive: Type.Object({
    focus: StringEnum([...PHASE_ORDER, "capability_repair"] as const),
    reason: Type.String(),
  }),
  safety_notes: Type.Array(Type.String()),
});

// ── Phase artifact ───────────────────────────────────────────────────

export interface PhaseArtifact {
  phase: Phase;
  cycle: number;
  status: "completed" | "failed_recoverable" | "blocked_by_safety_policy";
  errorClass?: ErrorKind;
  missingTool?: string;
  fallbackAttempted?: string;
  nextRecovery?: string;
  content: string; // Extracted assistant text or synthesized fallback
  timestamp: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolErrors: Array<{ name: string; error: string }>;
}

// ── Main goal state ──────────────────────────────────────────────────

export type RunStatus =
  | "running"
  | "paused_by_user"
  | "recovering"
  | "succeeded";

export interface EvaluatorConfig {
  model: string;
  provider: string;
  lastVerdict?: EvaluatorVerdict;
  completionRequiresEvaluator: true;
}

export interface GoalConstraints {
  neverStopUntilEvaluatorGoalMet: true;
  requireAllFourPhasesEachCycle: true;
  allowDestructiveOps: boolean;
  requireOperatorApprovalForDangerousOps: true;
}

export interface RunConfig {
  primaryModel: { provider: string; model: string };
  fallbackModels: Array<{ provider: string; model: string }>;
  blockedModels: Array<{
    provider: string;
    modelPattern: string;
    reason: string;
  }>;
}

export interface IterativeGoalState {
  version: 1;
  runId: string;
  goal: string;
  goalCriterion: string; // explicit completion criteria
  mode: "auto_until_external_evaluator_success";
  status: RunStatus;
  cycle: number;
  phase: Phase;
  requiredPhaseOrder: typeof PHASE_ORDER;
  evaluator: EvaluatorConfig;
  config: RunConfig;
  capabilities: CapabilitySnapshot | null;
  errors: IterativeGoalError[];
  artifacts: {
    research: PhaseArtifact[];
    plans: PhaseArtifact[];
    implementations: PhaseArtifact[];
    validations: PhaseArtifact[];
    evaluatorReports: EvaluatorVerdict[];
  };
  constraints: GoalConstraints;
}

// ── Persistence envelope ─────────────────────────────────────────────

export interface PersistenceEnvelope {
  version: number;
  state: IterativeGoalState;
  updatedAt: string;
}

// ── Phase result (LLM-facing) ────────────────────────────────────────

export const PhaseResultParams = Type.Object({
  phase: StringEnum([...PHASE_ORDER] as const),
  status: StringEnum(["completed", "failed_recoverable", "blocked_by_safety_policy"] as const),
  summary: Type.String({ description: "Brief summary of what was accomplished or attempted" }),
  artifacts_produced: Type.Array(Type.String()),
  blockers: Type.Array(Type.String()),
  recommendations: Type.Array(Type.String()),
});

export type PhaseResult = Static<typeof PhaseResultParams>;

// ── Evaluator prompt params ──────────────────────────────────────────

export const EvaluatorPromptSchema = Type.Object({
  goal_met: Type.Boolean(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  completion_blockers: Type.Array(Type.String()),
  accepted_evidence: Type.Array(Type.String()),
  rejected_evidence: Type.Array(Type.String()),
  remaining_work: Type.Array(
    Type.Object({
      priority: StringEnum(["critical", "high", "medium", "low"] as const),
      description: Type.String(),
    }),
  ),
  next_focus: StringEnum([...PHASE_ORDER, "capability_repair"] as const),
  next_focus_reason: Type.String(),
  safety_notes: Type.Array(Type.String()),
});

// ── Safety result ────────────────────────────────────────────────────

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
}