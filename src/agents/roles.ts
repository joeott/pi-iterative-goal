/**
 * Per-role subagent profiles (deployment plan Ch. 5 §5.2).
 *
 * Replaces the flat default budget ({maxTurns: 4, maxTokens: 16000,
 * timeoutMs: 300_000}) with role-appropriate budgets, tool inventories,
 * workspace modes, and typed output schemas, so the supervisor consumes
 * structured artifacts instead of prose. Every schema carries a verdict
 * or uncertainty field — reviewer verdicts stay distinct from the actor's
 * own summary (judge independence rule).
 *
 * Workspace split mirrors the pool's existing reader/writer substrate:
 * isolated_worktree for writers, read_only_snapshot for everyone else.
 * Test engineer is deliberately a writer scoped to test paths, so test
 * authorship parallelizes without touching implementation scopes; the
 * pool's cross-call activeWriteScopes registry makes that safe.
 */

import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

/** Canonical role list — AgentRole, the tool's enum, and profiles derive from this. */
export const AGENT_ROLES = [
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
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export type AgentWorkspaceMode = "read_only_snapshot" | "isolated_worktree";

export interface AgentRoleProfile {
  role: AgentRole;
  /** Role-appropriate tool inventory (tool-router principle), prompt-documented. */
  tools: string[];
  budget: {
    maxTurns: number;
    maxTokens: number;
    timeoutMs: number;
  };
  workspace: AgentWorkspaceMode;
  permittedEffects: string[];
  /** Writer roles hard-require allowedPaths under policy. */
  writer: boolean;
  /** "tests_only" restricts writer scopes to test paths (Test engineer). */
  allowedPathsPolicy: "none" | "required" | "tests_only";
  outputSchema: TSchema;
}

const VerdictSchema = StringEnum(["pass", "fail", "needs_work", "unknown"] as const);

const ScoutOutputSchema = Type.Object({
  claims: Type.Array(Type.String()),
  sources: Type.Array(Type.String()),
  confidence: Type.Number(),
  unknowns: Type.Array(Type.String()),
});

const RequirementsAnalystOutputSchema = Type.Object({
  requirements: Type.Array(Type.String()),
  constraints: Type.Array(Type.String()),
  acceptanceCriteria: Type.Array(Type.String()),
});

const PlannerOutputSchema = Type.Object({
  tasks: Type.Array(Type.String()),
  dependsOn: Type.Array(Type.String()),
  allowedPaths: Type.Array(Type.String()),
});

const ImplementerOutputSchema = Type.Object({
  summary: Type.String(),
  patchRef: Type.String(),
  filesChanged: Type.Array(Type.String()),
  testsRun: Type.Array(Type.String()),
  uncertainties: Type.Array(Type.String()),
});

const TestEngineerOutputSchema = Type.Object({
  testFiles: Type.Array(Type.String()),
  commands: Type.Array(Type.String()),
  verdict: VerdictSchema,
  coverageNotes: Type.Array(Type.String()),
});

const SecurityReviewerOutputSchema = Type.Object({
  findings: Type.Array(Type.Object({
    severity: StringEnum(["low", "medium", "high", "critical"] as const),
    path: Type.String(),
    evidence: Type.String(),
  })),
  verdict: VerdictSchema,
});

const ArchitectureAdvisorOutputSchema = Type.Object({
  hotspots: Type.Array(Type.String()),
  moduleDepthNotes: Type.Array(Type.String()),
  recommendations: Type.Array(Type.String()),
});

const DocumentationReviewerOutputSchema = Type.Object({
  gaps: Type.Array(Type.String()),
  inaccuracies: Type.Array(Type.String()),
  suggestedEdits: Type.Array(Type.String()),
});

const ReleaseReviewerOutputSchema = Type.Object({
  checklist: Type.Array(Type.Object({
    item: Type.String(),
    status: Type.String(),
  })),
  blockers: Type.Array(Type.String()),
  verdict: VerdictSchema,
});

const IntegratorOutputSchema = Type.Object({
  mergePlan: Type.Array(Type.String()),
  conflicts: Type.Array(Type.String()),
  resolvedPatchRef: Type.String(),
  verification: Type.String(),
});

export const AGENT_ROLE_PROFILES: Record<AgentRole, AgentRoleProfile> = {
  Scout: {
    role: "Scout",
    tools: ["fs.read", "web.*"],
    budget: { maxTurns: 6, maxTokens: 24_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: ScoutOutputSchema,
  },
  "Requirements analyst": {
    role: "Requirements analyst",
    tools: ["fs.read"],
    budget: { maxTurns: 4, maxTokens: 16_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: RequirementsAnalystOutputSchema,
  },
  Planner: {
    role: "Planner",
    tools: ["fs.read"],
    budget: { maxTurns: 6, maxTokens: 24_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: PlannerOutputSchema,
  },
  Implementer: {
    role: "Implementer",
    tools: ["fs.read", "fs.write", "process.exec"],
    budget: { maxTurns: 12, maxTokens: 60_000, timeoutMs: 900_000 },
    workspace: "isolated_worktree",
    permittedEffects: ["fs.write", "process.exec"],
    writer: true,
    allowedPathsPolicy: "required",
    outputSchema: ImplementerOutputSchema,
  },
  "Test engineer": {
    role: "Test engineer",
    tools: ["fs.read", "fs.write", "process.exec"],
    budget: { maxTurns: 10, maxTokens: 40_000, timeoutMs: 600_000 },
    workspace: "isolated_worktree",
    permittedEffects: ["fs.write", "process.exec"],
    writer: true,
    allowedPathsPolicy: "tests_only",
    outputSchema: TestEngineerOutputSchema,
  },
  "Security reviewer": {
    role: "Security reviewer",
    tools: ["fs.read", "process.exec"],
    budget: { maxTurns: 6, maxTokens: 24_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: SecurityReviewerOutputSchema,
  },
  "Architecture/Ousterhout advisor": {
    role: "Architecture/Ousterhout advisor",
    tools: ["fs.read"],
    budget: { maxTurns: 4, maxTokens: 16_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: ArchitectureAdvisorOutputSchema,
  },
  "Documentation reviewer": {
    role: "Documentation reviewer",
    tools: ["fs.read"],
    budget: { maxTurns: 4, maxTokens: 16_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: DocumentationReviewerOutputSchema,
  },
  "Release reviewer": {
    role: "Release reviewer",
    tools: ["fs.read", "process.exec"],
    budget: { maxTurns: 4, maxTokens: 16_000, timeoutMs: 300_000 },
    workspace: "read_only_snapshot",
    permittedEffects: [],
    writer: false,
    allowedPathsPolicy: "none",
    outputSchema: ReleaseReviewerOutputSchema,
  },
  Integrator: {
    role: "Integrator",
    tools: ["fs.read", "fs.write", "process.exec", "git.*"],
    budget: { maxTurns: 12, maxTokens: 60_000, timeoutMs: 900_000 },
    workspace: "isolated_worktree",
    permittedEffects: ["fs.write", "process.exec"],
    writer: true,
    allowedPathsPolicy: "required",
    outputSchema: IntegratorOutputSchema,
  },
};

export function getRoleProfile(role: AgentRole): AgentRoleProfile {
  return AGENT_ROLE_PROFILES[role];
}

export function isWriterRole(role: AgentRole): boolean {
  return AGENT_ROLE_PROFILES[role].writer;
}

/** Test-engineer scopes must stay inside test paths so authorship never collides with implementation scopes. */
export function isTestScopedPath(repoPath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(repoPath) || /\.(test|spec)\.[^/]+$/i.test(repoPath);
}

/** Compact output-contract hint injected into the subprocess prompt. */
export function outputContractHint(profile: AgentRoleProfile): string {
  const keys = Object.keys((profile.outputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  return keys.length > 0 ? keys.join(", ") : "";
}
