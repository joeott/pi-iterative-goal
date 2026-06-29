/**
 * Core types for the iterative-goal Pi extension.
 * Autonomous supervisor loop that never stops until an external evaluator
 * returns goal_met: true.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

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
    "validation_failure",
    "missing_authorization",
    "unsafe_request",
    "external_blocker",
    "policy_denied",
    "pending_approval",
    "approval_denied",
    "approval_expired",
    "dlp_secret_detected",
    "dlp_scanner_unavailable",
    "ipi_detected",
    "sanitizer_failure",
    "sandbox_violation",
    "sandbox_unavailable",
    "attestation_missing",
    "signature_invalid",
    "wrong_aws_account",
    "wrong_aws_region",
    "stale_or_deprecated_guidance",
    "cloudformation_risk_blocked",
    "aws_security_posture_blocked",
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

export type AwsCliProfileResolutionStep = "explicit" | "env" | "configured";

export type AwsCliMutatingFamily =
  | "ec2-start-stop-wait"
  | "ssm-session"
  | "ssm-send-command"
  | "s3-sync"
  | "s3-cp"
  | "logs-tail";

export interface AwsCliIdentity {
  account: string;
  arn: string;
  userId: string;
}

export interface AwsCliPreflight {
  enabled: boolean;
  cliAvailable: boolean;
  sessionManagerPluginAvailable: boolean;
  availableProfiles: string[];
  resolvedProfile: string | null;
  resolvedRegion: string | null;
  identity: AwsCliIdentity | null;
  issues: string[];
  checkedAt: string;
}

export interface AwsCliConfig {
  enabled: boolean;
  defaultRegion: string;
  profileResolutionOrder: AwsCliProfileResolutionStep[];
  profileCandidates: string[];
  requireSessionManagerPlugin: boolean;
  allowMutatingFamilies: AwsCliMutatingFamily[];
  preflight: AwsCliPreflight | null;
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
  awsCli: AwsCliPreflight | null;
  hasFilesystem: boolean;
  hasGit: boolean;
  hasNetwork: boolean;
  hasAws: boolean;
  hasAwsConfig: boolean;
  hasAwsSecurityHub: boolean;
  hasAwsAccessAnalyzer: boolean;
  hasScannerTools: boolean;
  hasSandbox: boolean;
  hasDlpProxy: boolean;
  hasIpiSanitizer: boolean;
  hasEvidenceSigner: boolean;
  cyberCapabilities: string[];
  unavailableCapabilities: string[];
  gitFinalization: {
    enabled: boolean;
    allowCommit: boolean;
    allowPush: boolean;
    allowPR: boolean;
    gitAvailable: boolean;
    ghAvailable: boolean;
    ghAuthenticated: boolean;
    currentBranch: string | null;
  } | null;
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
    focus: Phase | "capability_repair" | "external_blocked_complete" | "pending_approval";
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
    focus: StringEnum([...PHASE_ORDER, "capability_repair", "external_blocked_complete", "pending_approval"] as const),
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
  synthesis?: {
    source: "tool_report" | "assistant_text" | "assistant_tool_calls" | "synthetic_failure";
    nonceMatched: boolean;
    reason?: string;
  };
  dlpScanId?: string;
  trustClassification?: TrustClassification;
  attestationId?: string;
}

// ── Main goal state ──────────────────────────────────────────────────

export type RunStatus =
  | "running"
  | "paused_by_user"
  | "recovering"
  | "succeeded"
  | "completed_external_blockers"
  | "pending_approval"
  | "waiting_for_approval"
  | "blocked_external"
  | "requirement_conflict"
  | "budget_exhausted"
  | "provider_unavailable"
  | "policy_denied"
  | "manual_intervention_required";

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
  allowGitFinalization: boolean;
  requireOperatorApprovalForDangerousOps: true;
  subagentTimeoutMs: number;
  allowExternalNetworkScanning: boolean;
  allowProductionWriteActions: boolean;
  allowSecretMaterialCollection: boolean;
  allowLongLivedCredentials: boolean;
}

export interface RunConfig {
  primaryModel: { provider: string; model: string };
  fallbackModels: Array<{ provider: string; model: string }>;
  blockedModels: Array<{
    provider: string;
    modelPattern: string;
    reason: string;
  }>;
  modelHealth: Record<string, ModelHealthEntry>;
  awsCli: AwsCliConfig;
}

export interface IterativeGoalState {
  version: 2;
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
  projectInstructions: ProjectInstructionsState;
  errors: IterativeGoalError[];
  artifacts: {
    research: PhaseArtifact[];
    plans: PhaseArtifact[];
    implementations: PhaseArtifact[];
    validations: PhaseArtifact[];
    evaluatorReports: EvaluatorVerdict[];
  };
  taskPlan: TaskPlanState;
  constraints: GoalConstraints;
  trustBoundaries: TrustBoundaryState;
  approvals: ApprovalState;
  dlp: CyberDlpState;
  sanitizer: CyberSanitizationState;
  sandbox: CyberSandboxState;
  signing: CyberSigningState;
  attestations: ActionAttestation[];
  unifyCasProfile: CyberUnifyCasProfile;
  lock: RunLock;
  phaseAttempts: PhaseAttempt[];
  evaluatorState: EvaluatorState | null;
  finalizationPolicy: FinalizationPolicy;
  releaseAuthorization: ReleaseAuthorization | null;
}

// ── Durable task planning ───────────────────────────────────────────

export type TaskPlanItemStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";

export interface TaskPlanItem {
  id: string;
  title: string;
  status: TaskPlanItemStatus;
  detail: string | null;
  evidence: string[];
  updatedAt: string;
}

export interface TaskPlanState {
  updatedAt: string | null;
  updatedByPhaseAttemptId: string | null;
  rationale: string | null;
  items: TaskPlanItem[];
}

// ── Project instruction discovery ──────────────────────────────────

export interface ProjectInstructionFile {
  path: string;
  absolutePath: string;
  filename: "AGENTS.md" | "CLAUDE.md";
  sha256: string;
  bytes: number;
  content: string;
  truncated: boolean;
  precedence: number;
}

export interface ProjectInstructionsState {
  discoveredAt: string | null;
  repoRoot: string | null;
  cwd: string | null;
  files: ProjectInstructionFile[];
}

// ── Cyber / zero-trust runtime state ────────────────────────────────

export type TrustClassification = "trusted_control_plane" | "trusted_repo_policy" | "untrusted_data_plane";

export interface TrustBoundaryState {
  trustedControlPlaneSources: string[];
  trustedRepoPolicySources: string[];
  untrustedDataSources: string[];
}

export interface DlpScanSummary {
  scanId: string;
  scannedAt: string;
  detectedSecrets: number;
  detectorCounts: Record<string, number>;
}

export interface CyberDlpState {
  enabled: boolean;
  scannerAvailable: boolean;
  redactionCount: number;
  detectorCounts: Record<string, number>;
  lastScan: DlpScanSummary | null;
}

export interface CyberSanitizationState {
  enabled: boolean;
  sanitizerAvailable: boolean;
  lastSanitizedAt: string | null;
  ipiDetections: number;
}

export interface CyberSandboxState {
  enabled: boolean;
  profile: "readonly_inspection" | "test_untrusted_code" | "local_build" | "aws_cli_readonly" | "aws_mutation";
  networkDefaultDeny: boolean;
  readOnlyMountsByDefault: boolean;
  osLevelSandboxAvailable: boolean;
  lastViolation: string | null;
}

export interface CyberSigningState {
  required: true;
  algorithm: "ed25519";
  runPublicKey: string;
  privateKeyPem?: string;
  available: boolean;
  createdAt: string;
  keyId: string;
}

export interface ApprovalRequest {
  token: string;
  requestedAction: string;
  blastRadiusAssessment: string;
  justification: string;
  rollbackPlan: string;
  affectedResources: string[];
  exactCommands: string[];
  exactAwsActions: string[];
  dataAccessScope: string | null;
  requestedAt: string;
  expiresAt: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  resolvedAt: string | null;
}

export interface ApprovalState {
  pending: ApprovalRequest[];
  history: ApprovalRequest[];
}

export interface ActionAttestation {
  artifactId: string;
  runId: string;
  cycle: number;
  phase: string;
  path: string;
  type: "markdown" | "json" | "jsonl" | "log" | "diff" | "sarif" | "junit" | "text" | "in_toto" | "attestation";
  createdAt: string;
  sha256: string;
  cryptographicSignature: string;
  provenanceAttestation: Record<string, unknown>;
  dlpScanId: string | null;
  trustClassification: TrustClassification;
}

export interface CyberUnifyCasProfile {
  enabled: boolean;
  sourcePriority: string[];
  expectedAwsAccountId: string;
  expectedAwsRegion: string;
  canonicalOcrEngine: "unify_nemotron";
  deprecatedOcrEngines: string[];
  currentRouteSummary: string;
}

// ── Persistence envelope ─────────────────────────────────────────────

export interface PersistenceEnvelope {
  version: number;
  state: IterativeGoalState;
  updatedAt: string;
}

// ── Phase result (LLM-facing) ────────────────────────────────────────

// WARNING: When adding fields to PhaseResultParams, update the
// PhaseResultParamsSchema mapping in the validatePhaseParams function.
export const PhaseResultParams = Type.Object({
  runId: Type.String({ description: "MUST match the [HARNESS_META] runId from the phase prompt" }),
  phaseAttemptId: Type.String({ description: "MUST match the [HARNESS_META] phaseAttemptId from the phase prompt" }),
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
  next_focus: StringEnum([...PHASE_ORDER, "capability_repair", "external_blocked_complete", "pending_approval"] as const),
  next_focus_reason: Type.String(),
  safety_notes: Type.Array(Type.String()),
});

// ── Safety result ────────────────────────────────────────────────────

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
}

// ── Phase lifecycle events (transactional) ───────────────────────────

export const PhaseEventKind = [
  "phase_started",
  "model_selected",
  "tool_preflight_recorded",
  "phase_output_received",
  "phase_result_parsed",
  "phase_artifacts_persisted",
  "phase_result_committed",
  "evaluator_queued",
  "evaluator_started",
  "evaluator_verdict_recorded",
  "transition_decided",
  "next_phase_started",
  "model_fallback",
  "phase_cancelled",
  "run_paused",
  "run_resumed",
  "stale_phase_output_ignored",
] as const;
export type PhaseEventKind = (typeof PhaseEventKind)[number];

export interface PhaseLifecycleEvent {
  runId: string;
  cycle: number;
  phase: Phase;
  phaseAttemptId: string;
  attempt: number;
  kind: PhaseEventKind;
  timestamp: string;
  details?: Record<string, unknown>;
}

// ── Run lock (prevents interleaving) ─────────────────────────────────

export interface RunLock {
  activeRunId: string | null;
  activePhaseId: string | null;
  phaseLeaseOwner: string; // phaseAttemptId
  phaseStartedAt: string;
  phaseStatus: "running" | "result_submitted" | "validating" | "verdict_recorded" | "transition_pending" | "paused";
  queuedPhaseIds: string[]; // queued followUp messages for old runs
}

// ── Phase attempt tracking ───────────────────────────────────────────

export interface PhaseAttempt {
  runId: string;
  cycle: number;
  phase: Phase;
  attempt: number;
  phaseAttemptId: string;
  modelProvider: string;
  modelModel: string;
  fallbackChain: Array<{ provider: string; model: string; reason: string }>;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  outputReceived: boolean;
  resultParsed: boolean;
  artifactsPersisted: boolean;
  resultCommitted: boolean;
}

// ── Evaluator state (explicit, not inferred from file existence) ────

export type EvaluatorStatus = "queued" | "running" | "passed" | "failed" | "disabled" | "error" | "stale_heartbeat";

export interface EvaluatorState {
  runId: string;
  cycle: number;
  phase: "validate";
  status: EvaluatorStatus;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  verdictPath: string;
  error: string | null;
}

// ── Structured phase result (parseable, not free-form) ───────────────

export interface StructuredPhaseResult {
  runId: string;
  cycle: number;
  phase: Phase;
  overallStatus: "HARNESS_VALIDATED" | "HARNESS_VALIDATED_EXTERNAL_BLOCKERS" | "IN_PROGRESS" | "FAILED";
  tests: Array<{
    name: string;
    status: "PASS" | "FAIL" | "NOT_RUN";
    artifact: string;
    exitCode: number | null;
  }>;
  gates: Array<{
    name: string;
    status: "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED_EXTERNAL" | "BLOCKED_HARNESS";
    evidence: string | null;
  }>;
  blockers: Array<{
    kind: "BLOCKED_EXTERNAL" | "BLOCKED_HARNESS" | "UNKNOWN";
    message: string;
  }>;
  changedFiles: string[];
  commandsRun: string[];
  patchPath: string | null;
  uncommittedUserFilesTouched: boolean;
  nextRecommendedPhase: Phase | "capability_repair" | "external_blocked_complete";
}

// ── Finalization policy ──────────────────────────────────────────────

export interface FinalizationPolicy {
  allowGitFinalization: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowPR: boolean;
  fallback: "patch" | "none";
}

export interface ReleaseAuthorization {
  id: string;
  runId: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  planHash: string;
  requirementsHash: string;
  gateVerdictHash: string;
  evidenceRootHash: string;
  allowedAction: "git.pr.open";
  issuedAt: string;
  expiresAt: string;
}

// ── Model health cache ───────────────────────────────────────────────

export interface ModelHealthEntry {
  model: string;
  provider: string;
  lastStatus: "available" | "unavailable" | "unknown";
  lastCheckedAt: string;
  error: string | null;
  cooldownUntil: string | null;
}
