/**
 * State management and persistence for iterative-goal.
 *
 * Uses a factory function (not a class) to avoid jiti cross-module
 * class prototype resolution issues.
 *
 * Stores state in run-scoped directories:
 *   .pi/iterative-goal/
 *     active-run.json                – which run is active (lock)
 *     runs/
 *       <runId>/
 *         state.json                 – full machine-readable state
 *         events.jsonl               – append-only event log
 *         latest.md                  – human-readable summary
 *         evaluator-state.json       – explicit evaluator state
 *         evaluator-verdicts.jsonl   – evaluator verdicts
 *         cycles/
 *           <n>/
 *             research/
 *               prompt.md, result.json
 *             plan/
 *               prompt.md, result.json
 *             implement/
 *               prompt.md, result.json, diff.patch
 *             validate/
 *               prompt.md, result.json, test-results.txt, gate-results.txt, repo-state.txt
 *
 * Atomic persistence: write .tmp → fsync → rename.
 * New runs are restored from events.jsonl first. Snapshots remain a legacy
 * fallback and performance cache.
 *
 * Also uses pi.appendEntry() for session-level checkpoints
 * that survive compaction.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ActionAttestation,
  type ApprovalRequest,
  type CyberDlpState,
  type CyberSanitizationState,
  type CyberSandboxState,
  type IterativeGoalState,
  type EvaluatorVerdict,
  type PhaseArtifact,
  type IterativeGoalError,
  type RunStatus,
  type CapabilitySnapshot,
  type Phase,
  type PersistenceEnvelope,
  type RunLock,
  type PhaseAttempt,
  type PhaseLifecycleEvent,
  type EvaluatorState,
  type FinalizationPolicy,
  type ReleaseAuthorization,
  type SubagentTaskRecord,
  type SubagentTaskStatus,
  type SubagentUsageCounters,
  type TaskPlanState,
  type TrustedVerificationPolicyState,
  type ProjectInstructionsState,
  PHASE_ORDER,
} from "./types.js";
import {
  DEFAULT_UNIFY_CAS_PROFILE,
  createSigningState,
  defaultDlpState,
  defaultSanitizationState,
  defaultSandboxState,
} from "./cyber-runtime.js";
import {
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODELS,
  filterAllowedModels,
  normalizeConfiguredModel,
} from "./domain/models.js";
import type { PendingShardPlan, ShardClaimRecord, ShardMergeRecord, ShardPlan } from "./domain/shard.js";
import { logDebug } from "./logging.js";
import { validateApprovalForCommand } from "./domain/approval.js";

const PERSISTENCE_TYPE = "iterative-goal-state";
const DEFAULT_AWS_CLI_CONFIG = {
  enabled: false,
  defaultRegion: "us-east-1",
  profileResolutionOrder: ["explicit", "env", "configured"],
  profileCandidates: [],
  requireSessionManagerPlugin: true,
  allowMutatingFamilies: [],
  preflight: null,
} as const;

export interface StateManagerAPI {
  getState(): IterativeGoalState | null;
  isActive(): boolean;
  isPaused(): boolean;
  getVersion(): number;
  createRun(
    goal: string,
    goalCriterion: string,
    config?: Partial<IterativeGoalState["config"]>,
    trustedVerification?: TrustedVerificationPolicyState,
  ): IterativeGoalState;
  setCapabilities(snapshot: CapabilitySnapshot): void;
  setProjectInstructions(projectInstructions: ProjectInstructionsState): void;
  recordError(error: IterativeGoalError): void;
  recordArtifact(artifact: PhaseArtifact): void;
  recordVerdict(verdict: EvaluatorVerdict): void;
  setStatus(status: RunStatus): void;
  setPhase(phase: Phase): void;
  incrementCycle(): void;
  markSucceeded(): void;
  markCompletedBlocked(): void;
  clear(): void;
  persistAll(): void;

  // ── New: run-lock operations ───────────────────────────────────
  acquireLock(runId: string, phaseAttemptId: string): boolean;
  releaseLock(runId: string, phaseAttemptId: string): void;
  isLocked(): boolean;
  cancelQueuedPhases(runId: string): void;

  // ── New: phase attempt tracking ────────────────────────────────
  startPhaseAttempt(attempt: PhaseAttempt): void;
  completePhaseAttempt(phaseAttemptId: string, status: PhaseAttempt["status"]): void;
  recordPhaseEvent(event: PhaseLifecycleEvent): void;

  // ── New: evaluator state ───────────────────────────────────────
  setEvaluatorState(es: EvaluatorState): void;
  getEvaluatorState(): EvaluatorState | null;
  setReleaseAuthorization(auth: ReleaseAuthorization | null): void;
  updateTaskPlan(taskPlan: TaskPlanState): void;

  // ── New: swarm / subagent ledger (Campaign 1) ──────────────────
  recordSubagentStarted(task: SubagentTaskRecord): void;
  recordSubagentFinished(
    taskId: string,
    finish: { runId: string; status: SubagentTaskStatus; usage?: SubagentUsageCounters | null; error?: string | null },
  ): void;

  // ── New: sharder ledger (Campaign 2) ───────────────────────────
  setPendingShardPlan(entry: PendingShardPlan): void;
  clearPendingShardPlan(): void;
  recordShardPlan(shardPlan: ShardPlan): void;

  // ── New: scheduler claim ledger (Campaign 3) ───────────────────
  recordShardClaimed(claim: ShardClaimRecord, evidence?: Record<string, unknown>): void;
  recordShardFinished(
    shardId: string,
    finish: { runId: string; planId: string; cycle: number; status: "completed" | "failed"; taskId?: string | null; error?: string | null; patchArtifactPath?: string | null },
  ): void;

  // ── New: merge-back ledger (Campaign 4, §6.6) ──────────────────
  recordMergeProposed(merge: ShardMergeRecord): void;
  recordMergeVerified(
    shardId: string,
    verdict: {
      runId: string;
      planId: string;
      cycle: number;
      integrationCommitSha: string;
      gate: ShardMergeRecord["gate"];
      verifiedAt?: string;
    },
  ): void;
  updateDlpState(dlp: CyberDlpState): void;
  updateSanitizationState(sanitizer: CyberSanitizationState): void;
  recordAttestation(attestation: ActionAttestation): void;
  requestApproval(request: ApprovalRequest): void;
  resolveApproval(token: string, status: "approved" | "denied" | "expired"): ApprovalRequest | null;
  consumeApproval(token: string, command: string, cwd: string): { ok: true; request: ApprovalRequest } | { ok: false; reason: string };

  // ── New: artifact path helpers ─────────────────────────────────
  getRunDir(): string;
  getCycleDir(cycle: number): string;
  getPhaseDir(cycle: number, phase: Phase): string;
  getArtifactPath(cycle: number, phase: Phase, filename: string): string;
  getEventsPath(): string;
  replayActiveState(): IterativeGoalState | null;

  restore(ctx: ExtensionContext): IterativeGoalState | null;
}

export function nextPhase(current: Phase): Phase {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return "research";
  return PHASE_ORDER[idx + 1];
}

// ── Atomic file write ────────────────────────────────────────────

function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content);
  const fd = fs.openSync(tmpPath, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath);
}

function writeSecretFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

// ── JSONL append (atomic via tmp→fsync→rename not practical; use append.) ──

function appendJsonLine(filePath: string, obj: Record<string, unknown>): void {
  const line = JSON.stringify(obj) + "\n";
  fs.appendFileSync(filePath, line);
}

const EMPTY_EVENT_HASH = "0".repeat(64);

function hashEventPayload(event: Record<string, unknown>): string {
  const { eventHash: _eventHash, ...payload } = event;
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function readLastEventMetadata(filePath: string): { sequence: number; eventHash: string } {
  if (!fs.existsSync(filePath)) return { sequence: 0, eventHash: EMPTY_EVENT_HASH };
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { sequence: 0, eventHash: EMPTY_EVENT_HASH };
  const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  return {
    sequence: typeof last.sequence === "number" ? last.sequence : lines.length,
    eventHash: typeof last.eventHash === "string" ? last.eventHash : hashEventPayload(last),
  };
}

function verifyEventHashChain(events: Array<Record<string, unknown>>): boolean {
  let previousHash = EMPTY_EVENT_HASH;
  let sawChainedEvent = false;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const eventHash = event.eventHash;

    if (typeof eventHash === "string") {
      sawChainedEvent = true;
      if (event.sequence !== i + 1) return false;
      if (event.previousEventHash !== previousHash) return false;
      if (hashEventPayload(event) !== eventHash) return false;
      previousHash = eventHash;
      continue;
    }

    if (sawChainedEvent) return false;
    previousHash = hashEventPayload(event);
  }

  return true;
}

export function createStateManager(pi: ExtensionAPI): StateManagerAPI {
  let state: IterativeGoalState | null = null;
  let stateDir = "";
  let runDir = "";
  let currentPhaseAttemptId: string | null = null;
  // Monotonic change-feed counter. Bumped inside appendEvent (before hash
  // chaining) so every mutation is a complete invalidation signal — the
  // 1 Hz UI ticker polls this instead of per-call-site notify wiring.
  let version = 0;

  function phaseToArtifactKey(phase: Phase): keyof IterativeGoalState["artifacts"] {
    switch (phase) {
      case "research": return "research";
      case "plan": return "plans";
      case "implement": return "implementations";
      case "validate": return "validations";
    }
  }

  function runEventsPath(): string {
    return runDir ? path.join(runDir, "events.jsonl") : "";
  }

  function appendEvent(event: Record<string, unknown>): void {
    const eventsPath = runEventsPath();
    if (!eventsPath) return;
    version += 1;
    const previous = readLastEventMetadata(eventsPath);
    const auditable = {
      ...event,
      timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      sequence: previous.sequence + 1,
      previousEventHash: previous.eventHash,
    };
    appendJsonLine(eventsPath, { ...auditable, eventHash: hashEventPayload(auditable) });
  }

  type ReplayHandler = (replayed: IterativeGoalState, event: any) => void;

  const replayHandlers: Record<string, ReplayHandler> = {
    phase_attempt_started(replayed, event) {
      replayed.phaseAttempts.push(event.attempt);
    },
    phase_attempt_completed(replayed, event) {
      const attempt = replayed.phaseAttempts.find(a => a.phaseAttemptId === event.phaseAttemptId);
      if (attempt) {
        attempt.status = event.status;
        attempt.endedAt = event.timestamp;
      }
    },
    artifact_recorded(replayed, event) {
      const artifact = event.artifact as PhaseArtifact;
      const key = phaseToArtifactKey(artifact.phase);
      (replayed.artifacts[key] as PhaseArtifact[]).push(artifact);
    },
    verdict_recorded(replayed, event) {
      replayed.evaluator.lastVerdict = event.verdict;
      replayed.artifacts.evaluatorReports.push(event.verdict);
    },
    error_recorded(replayed, event) {
      replayed.errors.push(event.error);
    },
    status_changed(replayed, event) {
      replayed.status = event.status;
    },
    phase_changed(replayed, event) {
      replayed.phase = event.phase;
    },
    cycle_incremented(replayed, event) {
      replayed.cycle = event.cycle;
    },
    lock_acquired(replayed, event) {
      replayed.lock.activeRunId = event.runId;
      replayed.lock.activePhaseId = event.phaseAttemptId;
      replayed.lock.phaseLeaseOwner = event.phaseAttemptId;
      replayed.lock.phaseStartedAt = event.timestamp;
      replayed.lock.phaseStatus = "running";
    },
    lock_released(replayed, event) {
      if (replayed.lock.phaseLeaseOwner === event.phaseAttemptId) {
        replayed.lock.activePhaseId = null;
        replayed.lock.phaseLeaseOwner = "";
      }
    },
    queued_phases_cancelled(replayed) {
      replayed.lock.queuedPhaseIds = [];
      replayed.lock.phaseStatus = "paused";
    },
    evaluator_state_updated(replayed, event) {
      replayed.evaluatorState = event.evaluatorState;
    },
    release_authorization_updated(replayed, event) {
      replayed.releaseAuthorization = event.authorization ?? null;
    },
    task_plan_updated(replayed, event) {
      replayed.taskPlan = event.taskPlan;
    },
    dlp_state_updated(replayed, event) {
      replayed.dlp = event.dlp;
    },
    sanitizer_state_updated(replayed, event) {
      replayed.sanitizer = event.sanitizer;
    },
    attestation_recorded(replayed, event) {
      replayed.attestations.push(event.attestation);
    },
    approval_requested(replayed, event) {
      replayed.approvals.pending.push(event.request);
      replayed.status = "pending_approval";
      replayed.lock.phaseStatus = "paused";
    },
    approval_resolved(replayed, event) {
      const request = event.request as ApprovalRequest;
      replayed.approvals.pending = replayed.approvals.pending.filter((item) => item.token !== request.token);
      replayed.approvals.history.push(request);
      replayed.status = request.status === "approved" ? "running" : "policy_denied";
      replayed.lock.phaseStatus = request.status === "approved" ? "running" : "paused";
    },
    approval_consumed(replayed, event) {
      const request = replayed.approvals.history.find((item) => item.token === event.token);
      if (request) {
        request.usedAt = event.usedAt;
        request.usedForCommand = event.command;
      }
    },
    capabilities_updated(replayed, event) {
      replayed.capabilities = event.capabilities;
    },
    subagent_started(replayed, event) {
      const task = event.task as SubagentTaskRecord;
      if (typeof event.backend === "string") replayed.swarm.backend = event.backend;
      if (typeof event.detectedBackend === "string") replayed.swarm.detectedBackend = event.detectedBackend;
      replayed.swarm.tasks.push(task);
    },
    subagent_finished(replayed, event) {
      const task = replayed.swarm.tasks.find((item) => item.taskId === event.taskId);
      if (task) {
        task.status = event.status;
        task.finishedAt = event.timestamp;
        task.usage = event.usage ?? null;
        task.error = event.error ?? null;
      }
    },
    shard_plan_proposed(replayed, event) {
      // The typed plan awaits the plan→implement transition; cycle/attempt
      // guards in the sharder hook re-validate it against replayed state.
      replayed.shards.pendingPlan = event.entry as PendingShardPlan;
    },
    shard_posted(replayed, event) {
      // The hook consumes any pending typed plan when it commits a shard plan.
      replayed.shards.pendingPlan = null;
      replayed.shards.plans.push(event.shardPlan as ShardPlan);
    },
    shard_claimed(replayed, event) {
      const claim = event.claim as ShardClaimRecord;
      // Latest episode wins (repair loops re-claim); history stays in the log.
      const index = replayed.shards.claims.findIndex(
        (item) => item.planId === claim.planId && item.cycle === claim.cycle && item.shardId === claim.shardId,
      );
      if (index >= 0) replayed.shards.claims[index] = claim;
      else replayed.shards.claims.push(claim);
    },
    shard_completed(replayed, event) {
      const claim = replayed.shards.claims.find(
        (item) => item.planId === event.planId && item.cycle === event.cycle && item.shardId === event.shardId,
      );
      if (!claim) return; // Same unknown-record tolerance as subagent_finished.
      claim.status = "completed";
      claim.finishedAt = event.timestamp;
      claim.error = null;
      if (typeof event.taskId === "string") claim.taskId = event.taskId;
      claim.patchArtifactPath = typeof event.patchArtifactPath === "string" ? event.patchArtifactPath : null;
    },
    shard_failed(replayed, event) {
      const claim = replayed.shards.claims.find(
        (item) => item.planId === event.planId && item.cycle === event.cycle && item.shardId === event.shardId,
      );
      if (!claim) return;
      claim.status = "failed";
      claim.finishedAt = event.timestamp;
      claim.error = typeof event.error === "string" ? event.error : null;
      if (typeof event.taskId === "string") claim.taskId = event.taskId;
      // Figure D5 (§6.6): merge_proposed → failed on gate rejection. An open
      // merge proposal for this shard dies with the failure; the repair-loop
      // re-claim leaves the rejected record until a new proposal replaces it.
      const merge = replayed.shards.merges.find(
        (item) => item.planId === event.planId && item.cycle === event.cycle && item.shardId === event.shardId,
      );
      if (merge && merge.status === "proposed") {
        merge.status = "rejected";
        merge.error = typeof event.error === "string" ? event.error : null;
      }
    },
    merge_proposed(replayed, event) {
      const merge = event.merge as ShardMergeRecord;
      // Latest merge episode wins (repair re-proposals replace); the log
      // keeps every episode — same discipline as the claim ledger.
      const index = replayed.shards.merges.findIndex(
        (item) => item.planId === merge.planId && item.cycle === merge.cycle && item.shardId === merge.shardId,
      );
      if (index >= 0) replayed.shards.merges[index] = merge;
      else replayed.shards.merges.push(merge);
    },
    merge_verified(replayed, event) {
      const merge = replayed.shards.merges.find(
        (item) => item.planId === event.planId && item.cycle === event.cycle && item.shardId === event.shardId,
      );
      if (!merge) return; // Same unknown-record tolerance as shard_completed.
      merge.status = "verified";
      merge.verifiedAt = event.timestamp;
      merge.error = null;
      if (event.gate) merge.gate = event.gate as ShardMergeRecord["gate"];
      merge.integrationCommitSha = typeof event.integrationCommitSha === "string"
        ? event.integrationCommitSha
        : null;
    },
    project_instructions_updated(replayed, event) {
      replayed.projectInstructions = event.projectInstructions;
    },
    goal_met(replayed) {
      replayed.status = "succeeded";
      replayed.lock.phaseStatus = "verdict_recorded";
    },
    completed_external_blockers(replayed) {
      replayed.status = "completed_external_blockers";
      replayed.lock.phaseStatus = "verdict_recorded";
    },
    phase_lifecycle() {
      // Lifecycle events are audit evidence and do not mutate reconstructed state.
    },
  };

  function replayEvents(eventsPath: string): IterativeGoalState | null {
    if (!fs.existsSync(eventsPath)) return null;
    const lines = fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/).filter(Boolean);
    const parsedEvents: Array<Record<string, unknown>> = [];
    let replayed: IterativeGoalState | null = null;

    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return null;
      }
      parsedEvents.push(event);
    }

    if (!verifyEventHashChain(parsedEvents)) return null;

    for (const event of parsedEvents) {
      if (event.type === "run_created" && event.initialState) {
        replayed = migrateState(JSON.parse(JSON.stringify(event.initialState)));
        continue;
      }
      if (!replayed) continue;

      if (typeof event.type !== "string") return null;
      const handler = replayHandlers[event.type];
      if (!handler) return null;
      handler(replayed, event);
    }

    return replayed;
  }

  function eventsRequireReplay(eventsPath: string): boolean {
    if (!fs.existsSync(eventsPath)) return false;
    try {
      return fs.readFileSync(eventsPath, "utf-8").includes('"initialState"');
    } catch {
      return false;
    }
  }

  function persistAllInternal(): void {
    if (!state) return;
    persistToSession();
    persistToDisk();
    updateLatestMd();
  }

  function stateForPersistence(): IterativeGoalState | null {
    if (!state) return null;
    return {
      ...state,
      signing: {
        ...state.signing,
        privateKeyPem: undefined,
        available: state.signing.available && !!state.signing.runPublicKey,
      },
    };
  }

  /** Migrate v1 state or incomplete v2 state to current v2 format. */
  function migrateState(raw: any): IterativeGoalState {
    // v1 states lack lock, phaseAttempts, evaluatorState, finalizationPolicy, modelHealth
    if (!raw.lock) {
      raw.lock = {
        activeRunId: raw.runId ?? null,
        activePhaseId: null,
        phaseLeaseOwner: "",
        phaseStartedAt: new Date().toISOString(),
        phaseStatus: raw.status === "running" ? "paused" : "verdict_recorded",
        queuedPhaseIds: [],
      };
    }
    if (!raw.phaseAttempts) raw.phaseAttempts = [];
    if (!raw.evaluatorState) raw.evaluatorState = null;
    if (!raw.finalizationPolicy) {
      raw.finalizationPolicy = {
        allowGitFinalization: raw.constraints?.allowGitFinalization ?? false,
        allowCommit: false,
        allowPush: false,
        allowPR: false,
        fallback: "patch",
      };
    }
    if (!raw.config?.modelHealth) {
      if (!raw.config) raw.config = {};
      raw.config.modelHealth = {};
    }
    if (!raw.config?.awsCli) {
      if (!raw.config) raw.config = {};
      raw.config.awsCli = {
        ...DEFAULT_AWS_CLI_CONFIG,
        profileResolutionOrder: [...DEFAULT_AWS_CLI_CONFIG.profileResolutionOrder],
        profileCandidates: [...DEFAULT_AWS_CLI_CONFIG.profileCandidates],
        allowMutatingFamilies: [...DEFAULT_AWS_CLI_CONFIG.allowMutatingFamilies],
      };
    } else {
      raw.config.awsCli = {
        ...DEFAULT_AWS_CLI_CONFIG,
        ...raw.config.awsCli,
        profileResolutionOrder: Array.isArray(raw.config.awsCli.profileResolutionOrder)
          ? [...raw.config.awsCli.profileResolutionOrder]
          : [...DEFAULT_AWS_CLI_CONFIG.profileResolutionOrder],
        profileCandidates: Array.isArray(raw.config.awsCli.profileCandidates)
          ? [...raw.config.awsCli.profileCandidates]
          : [...DEFAULT_AWS_CLI_CONFIG.profileCandidates],
        allowMutatingFamilies: Array.isArray(raw.config.awsCli.allowMutatingFamilies)
          ? [...raw.config.awsCli.allowMutatingFamilies]
          : [...DEFAULT_AWS_CLI_CONFIG.allowMutatingFamilies],
      };
    }
    raw.config.primaryModel = normalizeConfiguredModel(raw.config.primaryModel);
    raw.config.fallbackModels = filterAllowedModels(raw.config.fallbackModels ?? []);
    if (raw.config.fallbackModels.length === 0) {
      raw.config.fallbackModels = DEFAULT_FALLBACK_MODELS.map((model) => ({ ...model }));
    }
    if (!("releaseAuthorization" in raw)) raw.releaseAuthorization = null;
    if (!raw.taskPlan) {
      raw.taskPlan = {
        updatedAt: null,
        updatedByPhaseAttemptId: null,
        rationale: null,
        items: [],
      };
    }
    if (!raw.projectInstructions) {
      raw.projectInstructions = {
        discoveredAt: null,
        repoRoot: null,
        cwd: null,
        files: [],
      };
    }
    if (raw.status === "waiting_for_approval") raw.status = "pending_approval";
    if (!raw.trustBoundaries) {
      raw.trustBoundaries = {
        trustedControlPlaneSources: ["harness policy", "operator approval token", "external evaluator verdict"],
        trustedRepoPolicySources: DEFAULT_UNIFY_CAS_PROFILE.sourcePriority,
        untrustedDataSources: ["tool output", "logs", "cloud API responses", "file contents", "web data", "test output"],
      };
    }
    if (!raw.approvals) raw.approvals = { pending: [], history: [] };
    if (!raw.dlp) raw.dlp = defaultDlpState();
    if (!raw.sanitizer) raw.sanitizer = defaultSanitizationState();
    if (!raw.sandbox) raw.sandbox = defaultSandboxState();
    if (!raw.signing) raw.signing = createSigningState(raw.runId ?? "restored-run");
    if (!raw.signing.privateKeyPem) raw.signing.available = false;
    if (!raw.trustedVerification) {
      raw.trustedVerification = { required: false, checksHash: null, pinnedAt: new Date(0).toISOString() };
    }
    if (!raw.attestations) raw.attestations = [];
    if (!raw.unifyCasProfile) raw.unifyCasProfile = { ...DEFAULT_UNIFY_CAS_PROFILE };
    if (!raw.swarm || typeof raw.swarm !== "object") raw.swarm = { backend: null, detectedBackend: null, tasks: [] };
    if (!Array.isArray(raw.swarm.tasks)) raw.swarm.tasks = [];
    if (!("detectedBackend" in raw.swarm)) raw.swarm.detectedBackend = null;
    if (!raw.shards || typeof raw.shards !== "object") raw.shards = { pendingPlan: null, plans: [] };
    if (!Array.isArray(raw.shards.plans)) raw.shards.plans = [];
    if (!("pendingPlan" in raw.shards)) raw.shards.pendingPlan = null;
    if (!Array.isArray(raw.shards.claims)) raw.shards.claims = [];
    // C4 merge ledger backfill: runs ledgered before merge-back replay into
    // the new field as empty — no merge events exist to replay into it.
    if (!Array.isArray(raw.shards.merges)) raw.shards.merges = [];
    for (const merge of raw.shards.merges) {
      if (merge && typeof merge === "object" && !("integrationCommitSha" in merge)) {
        merge.integrationCommitSha = null;
      }
    }
    raw.constraints = {
      ...(raw.constraints ?? {}),
      neverStopUntilEvaluatorGoalMet: true,
      requireAllFourPhasesEachCycle: true,
      allowDestructiveOps: raw.constraints?.allowDestructiveOps ?? false,
      allowGitFinalization: raw.constraints?.allowGitFinalization ?? false,
      requireOperatorApprovalForDangerousOps: true,
      subagentTimeoutMs: raw.constraints?.subagentTimeoutMs ?? 300_000,
      allowExternalNetworkScanning: raw.constraints?.allowExternalNetworkScanning ?? false,
      allowProductionWriteActions: raw.constraints?.allowProductionWriteActions ?? false,
      allowSecretMaterialCollection: raw.constraints?.allowSecretMaterialCollection ?? false,
      allowLongLivedCredentials: raw.constraints?.allowLongLivedCredentials ?? false,
    };
    raw.version = 2;
    return raw as IterativeGoalState;
  }

  function persistToSession(): void {
    if (!state) return;
    const envelope: PersistenceEnvelope = {
      version: 2,
      state: stateForPersistence()!,
      updatedAt: new Date().toISOString(),
    };
    pi.appendEntry(PERSISTENCE_TYPE, envelope);
  }

  function persistToDisk(): void {
    if (!state || !runDir) return;
    const statePath = path.join(runDir, "state.json");
    const envelope: PersistenceEnvelope = {
      version: 2,
      state: stateForPersistence()!,
      updatedAt: new Date().toISOString(),
    };
    writeFileAtomic(statePath, JSON.stringify(envelope, null, 2));
  }

  function persistLock(): void {
    if (!state || !stateDir) return;
    const lock: RunLock = state.lock;
    const lockPath = path.join(stateDir, "active-run.json");
    writeFileAtomic(lockPath, JSON.stringify(lock, null, 2));
  }

  function persistEvaluatorState(): void {
    if (!state || !runDir) return;
    const es = state.evaluatorState;
    if (!es) return;
    const esPath = path.join(runDir, "evaluator-state.json");
    writeFileAtomic(esPath, JSON.stringify(es, null, 2));
  }

  // Crash reconciliation (C1-ADV-010): replay stays deterministic — it
  // restores in-flight tasks as running; only at load time do we mark them
  // failed, since the pool that ran them died with the previous process.
  // Each reconciliation is itself a hash-chained subagent_finished event.
  // C3 extension (C3-ADV-009): every dispatched shard claim still stuck in
  // claimed belongs to the process that just died and must fail closed. This
  // includes the two narrow crash windows where the process stopped after
  // shard_claimed but before subagent_started, or after subagent_finished but
  // before shard_completed. Restricting reconciliation to a currently-running
  // task strands both windows forever. A taskId:null claim is deliberately
  // excluded: C4 uses that shape for its ledgered repair loop.
  function reconcileRunningSubagents(): void {
    if (!state) return;
    const orphaned = state.swarm.tasks.filter((task) => task.status === "running");
    for (const task of orphaned) {
      const finishedAt = new Date().toISOString();
      task.status = "failed";
      task.finishedAt = finishedAt;
      task.error = "process_restart";
      appendEvent({
        type: "subagent_finished",
        taskId: task.taskId,
        status: "failed",
        usage: null,
        error: "process_restart",
        timestamp: finishedAt,
      });
    }
    if (orphaned.length > 0) {
      logDebug("state", `reconciled ${orphaned.length} orphaned running subagent task(s) as failed: process_restart`);
    }
    const orphanedClaims = state.shards.claims.filter(
      (claim) => claim.status === "claimed" && claim.taskId !== null,
    );
    for (const claim of orphanedClaims) {
      const finishedAt = new Date().toISOString();
      claim.status = "failed";
      claim.finishedAt = finishedAt;
      claim.error = "process_restart";
      appendEvent({
        type: "shard_failed",
        shardId: claim.shardId,
        planId: claim.planId,
        cycle: claim.cycle,
        taskId: claim.taskId,
        error: "process_restart",
        timestamp: finishedAt,
      });
    }
    if (orphanedClaims.length > 0) {
      logDebug("state", `reconciled ${orphanedClaims.length} orphaned claimed shard(s) as failed: process_restart`);
    }
  }

  // Stale merge reconciliation (C4-OUS-001): a merge stuck in proposed at
  // load time means the gating process died between dispatch and verdict
  // (kill -9 mid-gate). Replay stays deterministic — the proposal replays
  // as-is; only at load time do we fail it back through the Figure D5 repair
  // loop with process_restart evidence (mirroring C3-ADV-009's claim rule):
  // proposed → rejected, claim completed → failed → claimed, so a warm
  // restart re-drives the merge from the ledgered patch artifact instead of
  // wedging the run on a gate that will never verdict. Each transition is
  // itself a hash-chained event, so live and replayed state converge.
  function reconcileStaleMergeProposals(): void {
    if (!state) return;
    const stale = state.shards.merges.filter((merge) => merge.status === "proposed");
    for (const merge of stale) {
      const claim = state.shards.claims.find(
        (item) => item.planId === merge.planId && item.cycle === merge.cycle && item.shardId === merge.shardId,
      );
      // Only a completed claim can carry an open proposal; anything else is
      // already on a repair path (or inconsistent in a way replay tolerated).
      if (!claim || claim.status !== "completed") continue;
      const failedAt = new Date().toISOString();
      claim.status = "failed";
      claim.finishedAt = failedAt;
      claim.error = "process_restart";
      merge.status = "rejected";
      merge.error = "process_restart";
      appendEvent({
        type: "shard_failed",
        shardId: merge.shardId,
        planId: merge.planId,
        cycle: merge.cycle,
        taskId: claim.taskId,
        error: "process_restart",
        timestamp: failedAt,
      });
      const reclaimedAt = new Date().toISOString();
      const reclaimed: ShardClaimRecord = {
        ...claim,
        status: "claimed",
        taskId: null,
        claimedAt: reclaimedAt,
        finishedAt: null,
        error: "process_restart",
      };
      const index = state.shards.claims.findIndex(
        (item) => item.planId === claim.planId && item.cycle === claim.cycle && item.shardId === claim.shardId,
      );
      state.shards.claims[index] = reclaimed;
      appendEvent({
        type: "shard_claimed",
        shardId: merge.shardId,
        planId: merge.planId,
        cycle: merge.cycle,
        claim: reclaimed,
        evidence: {
          repairLoop: true,
          staleMergeReconciled: true,
          reason: "merge proposal open at process start — the gating process died mid-gate; returned to claimed for repair (Figure D5)",
        },
        timestamp: reclaimedAt,
      });
    }
    if (stale.length > 0) {
      logDebug("state", `reconciled ${stale.length} stale proposed merge(s) back to claimed: process_restart`);
    }
  }

  function reconcileAfterRestore(): void {
    reconcileRunningSubagents();
    reconcileStaleMergeProposals();
  }

  function ensureRunDirs(): void {
    if (!stateDir || !state?.runId) return;
    runDir = path.join(stateDir, "runs", state.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const cyclesDir = path.join(runDir, "cycles");
    fs.mkdirSync(cyclesDir, { recursive: true });

    const eventsPath = path.join(runDir, "events.jsonl");
    if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "");

    const verdictsPath = path.join(runDir, "evaluator-verdicts.jsonl");
    if (!fs.existsSync(verdictsPath)) fs.writeFileSync(verdictsPath, "");
    const approvalsPath = path.join(runDir, "approvals.jsonl");
    if (!fs.existsSync(approvalsPath)) fs.writeFileSync(approvalsPath, "");
    const redactionsPath = path.join(runDir, "dlp-redactions.jsonl");
    if (!fs.existsSync(redactionsPath)) fs.writeFileSync(redactionsPath, "");
    const attestationsPath = path.join(runDir, "attestations.jsonl");
    if (!fs.existsSync(attestationsPath)) fs.writeFileSync(attestationsPath, "");
    const taskPlanPath = path.join(runDir, "task-plan.jsonl");
    if (!fs.existsSync(taskPlanPath)) fs.writeFileSync(taskPlanPath, "");
    hydrateOrPersistSigningKey();
  }

  /**
   * The private run signer is intentionally excluded from session/state/event
   * persistence, but a long-running goal must survive a supervisor restart.
   * Keep it in one run-owned 0600 file and accept it only when it derives the
   * public key already pinned in the hash-chained run state.
   */
  function hydrateOrPersistSigningKey(): void {
    if (!state || !runDir) return;
    const keyPath = path.join(runDir, ".signing-private.pem");
    if (!fs.existsSync(keyPath)) {
      if (!state.signing.available || !state.signing.privateKeyPem) return;
      writeSecretFileAtomic(keyPath, state.signing.privateKeyPem);
      return;
    }

    try {
      const metadata = fs.lstatSync(keyPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error("run signing key ownership or mode is unsafe");
      }
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("run signing key is owned by another user");
      }
      if (metadata.size <= 0 || metadata.size > 16 * 1024) throw new Error("run signing key has an invalid size");
      const privateKeyPem = fs.readFileSync(keyPath, "utf8");
      const derivedPublicKey = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
        .export({ type: "spki", format: "pem" })
        .toString();
      if (derivedPublicKey !== state.signing.runPublicKey) throw new Error("run signing key does not match the pinned public key");
      state.signing.privateKeyPem = privateKeyPem;
      state.signing.available = true;
    } catch (error) {
      state.signing.privateKeyPem = undefined;
      state.signing.available = false;
      logDebug("state", `run signing key unavailable after secure restore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function ensurePhaseDirs(cycle: number, phase: Phase): string {
    const dir = path.join(runDir, "cycles", String(cycle), phase);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function updateLatestMd(): void {
    if (!state || !runDir) return;

    const s = state;
    const lastArtifact = [
      ...s.artifacts.research,
      ...s.artifacts.plans,
      ...s.artifacts.implementations,
      ...s.artifacts.validations,
    ].at(-1) ?? null;
    const lines = [
      `# Iterative Goal Status`,
      ``,
      `- **Run ID**: ${s.runId}`,
      `- **Goal**: ${s.goal}`,
      `- **Criterion**: ${s.goalCriterion}`,
      `- **Status**: ${s.status}`,
      `- **Cycle**: ${s.cycle}`,
      `- **Phase**: ${s.phase}`,
      `- **DLP Redactions**: ${s.dlp.redactionCount}`,
      `- **IPI Detections**: ${s.sanitizer.ipiDetections}`,
      `- **Evidence Signer**: ${s.signing.available ? "available" : "unavailable"} (${s.signing.keyId})`,
      `- **Pending Approvals**: ${s.approvals.pending.length}`,
      `- **Project Instructions**: ${s.projectInstructions.files.length}`,
      ``,
      `## Task Plan`,
      ``,
      `- **Updated**: ${s.taskPlan.updatedAt ?? "never"}`,
      `- **Updated By**: ${s.taskPlan.updatedByPhaseAttemptId ?? "none"}`,
      `- **Items**: ${s.taskPlan.items.length}`,
      `- **In Progress**: ${s.taskPlan.items.find(item => item.status === "in_progress")?.title ?? "none"}`,
      ``,
      `## Lock`,
      ``,
      `- **Active Run**: ${s.lock.activeRunId ?? "none"}`,
      `- **Active Phase**: ${s.lock.activePhaseId ?? "none"}`,
      `- **Phase Status**: ${s.lock.phaseStatus}`,
      `- **Queued Phase IDs**: [${s.lock.queuedPhaseIds.join(", ")}]`,
      ``,
      `## Project Instructions`,
      ``,
      `- **Discovered**: ${s.projectInstructions.discoveredAt ?? "never"}`,
      `- **Repo Root**: ${s.projectInstructions.repoRoot ?? "unknown"}`,
      `- **Current Path**: ${s.projectInstructions.cwd ?? "unknown"}`,
      ...s.projectInstructions.files.map(file =>
        `- ${file.path} (${file.filename}, sha256=${file.sha256}, truncated=${file.truncated ? "yes" : "no"})`),
      ``,
      `## Evaluator`,
      ``,
      `- **Model**: ${s.evaluator.provider}/${s.evaluator.model}`,
      `- **Last Verdict**: ${s.evaluator.lastVerdict ? `goal_met=${s.evaluator.lastVerdict.goal_met}, confidence=${s.evaluator.lastVerdict.confidence}` : "none yet"}`,
      s.evaluatorState ? `- **Evaluator Status**: ${s.evaluatorState.status}` : `- **Evaluator Status**: not started`,
      ``,
      `## Artifacts`,
      ``,
      `- Research: ${s.artifacts.research.length}`,
      `- Plans: ${s.artifacts.plans.length}`,
      `- Implementations: ${s.artifacts.implementations.length}`,
      `- Validations: ${s.artifacts.validations.length}`,
      `- Evaluator Reports: ${s.artifacts.evaluatorReports.length}`,
      ``,
      `## Latest Artifact`,
      ``,
      `- **Present**: ${lastArtifact ? "yes" : "no"}`,
      `- **Phase**: ${lastArtifact?.phase ?? "none"}`,
      `- **Status**: ${lastArtifact?.status ?? "none"}`,
      `- **Source**: ${lastArtifact?.synthesis?.source ?? "unknown"}`,
      `- **Nonce Matched**: ${lastArtifact ? String(lastArtifact.synthesis?.nonceMatched ?? false) : "n/a"}`,
      `- **Reason**: ${lastArtifact?.synthesis?.reason ?? "none"}`,
      ``,
      `## Errors (${s.errors.length})`,
      ``,
    ];

    for (const err of s.errors.slice(-10)) {
      lines.push(`- [${err.phase}] ${err.kind}${err.missingTool ? `:${err.missingTool}` : ""} - ${err.recoveryAction}${err.resolved ? " ✓" : ""}`);
    }

    if (s.taskPlan.items.length > 0) {
      lines.push(``, `## Task Plan Items`, ``);
      for (const item of s.taskPlan.items) {
        const detail = item.detail ? ` - ${item.detail}` : "";
        lines.push(`- [${item.status}] ${item.id}: ${item.title}${detail}`);
      }
    }

    if (s.evaluator.lastVerdict) {
      const v = s.evaluator.lastVerdict;
      lines.push(
        ``,
        `## Last Evaluator Verdict`,
        ``,
        `- **goal_met**: ${v.goal_met}`,
        `- **confidence**: ${v.confidence}`,
        `- **completion blockers**: ${v.completion_blockers.length}`,
        `- **next focus**: ${v.next_cycle_directive.focus}`,
      );

      if (v.completion_blockers.length > 0) {
        lines.push(``, `### Blockers`);
        for (const b of v.completion_blockers) {
          lines.push(`- ${b}`);
        }
      }

      if (v.remaining_work.length > 0) {
        lines.push(``, `### Remaining Work`);
        for (const w of v.remaining_work) {
          lines.push(`- [${w.priority}] ${w.description}`);
        }
      }
    }

    const latestPath = path.join(runDir, "latest.md");
    fs.writeFileSync(latestPath, lines.join("\n"));
  }

  function initStateDir(cwd: string): void {
    stateDir = path.join(cwd, ".pi", "iterative-goal");
    fs.mkdirSync(stateDir, { recursive: true });
  }

  return {
    getState(): IterativeGoalState | null {
      return state;
    },

    isActive(): boolean {
      return state !== null && state.status === "running";
    },

    isPaused(): boolean {
      return state !== null && state.status === "paused_by_user";
    },

    getVersion(): number {
      return version;
    },

    // ── Run-scoped paths ──────────────────────────────────────────

    getRunDir(): string {
      return runDir;
    },

    getCycleDir(cycle: number): string {
      return path.join(runDir, "cycles", String(cycle));
    },

    getPhaseDir(cycle: number, phase: Phase): string {
      return ensurePhaseDirs(cycle, phase);
    },

    getArtifactPath(cycle: number, phase: Phase, filename: string): string {
      ensurePhaseDirs(cycle, phase);
      return path.join(runDir, "cycles", String(cycle), phase, filename);
    },

    createRun(
      goal: string,
      goalCriterion: string,
      config?: Partial<IterativeGoalState["config"]>,
      trustedVerification?: TrustedVerificationPolicyState,
    ): IterativeGoalState {
      const runId = `ig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      state = {
        version: 2,
        runId,
        goal,
        goalCriterion,
        mode: "auto_until_external_evaluator_success",
        status: "running",
        cycle: 1,
        phase: "research",
        requiredPhaseOrder: PHASE_ORDER,
        evaluator: {
          model: config?.primaryModel?.model ?? DEFAULT_PRIMARY_MODEL.model,
          provider: config?.primaryModel?.provider ?? DEFAULT_PRIMARY_MODEL.provider,
          completionRequiresEvaluator: true,
        },
        config: {
          primaryModel: normalizeConfiguredModel(config?.primaryModel),
          fallbackModels: filterAllowedModels(config?.fallbackModels ?? DEFAULT_FALLBACK_MODELS.map((model) => ({ ...model }))),
          blockedModels: config?.blockedModels ?? [],
          modelHealth: config?.modelHealth ?? {},
          awsCli: {
            ...DEFAULT_AWS_CLI_CONFIG,
            ...(config?.awsCli ?? {}),
            profileResolutionOrder: config?.awsCli?.profileResolutionOrder
              ? [...config.awsCli.profileResolutionOrder]
              : [...DEFAULT_AWS_CLI_CONFIG.profileResolutionOrder],
            profileCandidates: config?.awsCli?.profileCandidates
              ? [...config.awsCli.profileCandidates]
              : [...DEFAULT_AWS_CLI_CONFIG.profileCandidates],
            allowMutatingFamilies: config?.awsCli?.allowMutatingFamilies
              ? [...config.awsCli.allowMutatingFamilies]
              : [...DEFAULT_AWS_CLI_CONFIG.allowMutatingFamilies],
          },
        },
        capabilities: null,
        projectInstructions: {
          discoveredAt: null,
          repoRoot: null,
          cwd: null,
          files: [],
        },
        errors: [],
        artifacts: {
          research: [],
          plans: [],
          implementations: [],
          validations: [],
          evaluatorReports: [],
        },
        taskPlan: {
          updatedAt: null,
          updatedByPhaseAttemptId: null,
          rationale: null,
          items: [],
        },
        constraints: {
          neverStopUntilEvaluatorGoalMet: true,
          requireAllFourPhasesEachCycle: true,
          allowDestructiveOps: false,
          allowGitFinalization: false,
          requireOperatorApprovalForDangerousOps: true,
          subagentTimeoutMs: 300_000,
          allowExternalNetworkScanning: false,
          allowProductionWriteActions: false,
          allowSecretMaterialCollection: false,
          allowLongLivedCredentials: false,
        },
        trustBoundaries: {
          trustedControlPlaneSources: ["harness policy", "operator approval token", "external evaluator verdict"],
          trustedRepoPolicySources: DEFAULT_UNIFY_CAS_PROFILE.sourcePriority,
          untrustedDataSources: ["tool output", "logs", "cloud API responses", "file contents", "web data", "test output"],
        },
        approvals: { pending: [], history: [] },
        dlp: defaultDlpState(),
        sanitizer: defaultSanitizationState(),
        sandbox: defaultSandboxState(),
        signing: createSigningState(runId),
        trustedVerification: trustedVerification ?? {
          required: false,
          checksHash: null,
          pinnedAt: new Date().toISOString(),
        },
        attestations: [],
        unifyCasProfile: { ...DEFAULT_UNIFY_CAS_PROFILE },
        lock: {
          activeRunId: runId,
          activePhaseId: null,
          phaseLeaseOwner: "",
          phaseStartedAt: new Date().toISOString(),
          phaseStatus: "running",
          queuedPhaseIds: [],
        },
        phaseAttempts: [],
        evaluatorState: null,
        finalizationPolicy: {
          allowGitFinalization: false,
          allowCommit: false,
          allowPush: false,
          allowPR: false,
          fallback: "patch",
        },
        releaseAuthorization: null,
        swarm: { backend: null, detectedBackend: null, tasks: [] },
        shards: { pendingPlan: null, plans: [], claims: [], merges: [] },
      };

      ensureRunDirs();
      persistLock();
      persistAllInternal();
      appendEvent({
        type: "run_created",
        runId,
        goal,
        goalCriterion,
        initialState: stateForPersistence(),
        timestamp: new Date().toISOString(),
      });

      return state!;
    },

    // ── Run lock ──────────────────────────────────────────────────

    acquireLock(runId: string, phaseAttemptId: string): boolean {
      if (!state) return false;
      const activeRun = state.lock.activeRunId;
      if (activeRun && activeRun !== runId) {
        // Different run is active — refuse
        return false;
      }
      state.lock.activeRunId = runId;
      state.lock.activePhaseId = phaseAttemptId;
      state.lock.phaseLeaseOwner = phaseAttemptId;
      state.lock.phaseStartedAt = new Date().toISOString();
      state.lock.phaseStatus = "running";
      persistLock();
      appendEvent({ type: "lock_acquired", runId, phaseAttemptId, timestamp: new Date().toISOString() });
      return true;
    },

    releaseLock(runId: string, phaseAttemptId: string): void {
      if (!state) return;
      if (state.lock.phaseLeaseOwner !== phaseAttemptId) return;
      state.lock.activePhaseId = null;
      state.lock.phaseLeaseOwner = "";
      persistLock();
      appendEvent({ type: "lock_released", runId, phaseAttemptId, timestamp: new Date().toISOString() });
    },

    isLocked(): boolean {
      if (!state) return false;
      return state.lock.activePhaseId !== null && state.lock.phaseStatus === "running";
    },

    cancelQueuedPhases(runId: string): void {
      if (!state) return;
      if (state.lock.activeRunId === runId) {
        state.lock.queuedPhaseIds = [];
        state.lock.phaseStatus = "paused";
        persistLock();
        appendEvent({
          type: "queued_phases_cancelled",
          runId,
          timestamp: new Date().toISOString(),
        });
      }
    },

    // ── Phase attempts ────────────────────────────────────────────

    startPhaseAttempt(attempt: PhaseAttempt): void {
      if (!state) return;
      currentPhaseAttemptId = attempt.phaseAttemptId;
      state.phaseAttempts.push(attempt);
      appendEvent({
        type: "phase_attempt_started",
        attempt,
        timestamp: new Date().toISOString(),
      });
    },

    completePhaseAttempt(phaseAttemptId: string, status: PhaseAttempt["status"]): void {
      if (!state) return;
      const attempt = state.phaseAttempts.find(a => a.phaseAttemptId === phaseAttemptId);
      if (attempt) {
        attempt.status = status;
        attempt.endedAt = new Date().toISOString();
        appendEvent({
          type: "phase_attempt_completed",
          phaseAttemptId,
          status,
          timestamp: new Date().toISOString(),
        });
      }
      if (currentPhaseAttemptId === phaseAttemptId) {
        currentPhaseAttemptId = null;
      }
    },

    recordPhaseEvent(event: PhaseLifecycleEvent): void {
      if (!state) return;
      appendEvent({
        type: "phase_lifecycle",
        ...event,
      });
    },

    // ── Evaluator state ───────────────────────────────────────────

    setEvaluatorState(es: EvaluatorState): void {
      if (!state) return;
      state.evaluatorState = es;
      persistEvaluatorState();
      appendEvent({ type: "evaluator_state_updated", evaluatorState: es, timestamp: new Date().toISOString() });
    },

    getEvaluatorState(): EvaluatorState | null {
      return state?.evaluatorState ?? null;
    },

    setReleaseAuthorization(auth: ReleaseAuthorization | null): void {
      if (!state) return;
      state.releaseAuthorization = auth;
      appendEvent({ type: "release_authorization_updated", authorization: auth, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    updateTaskPlan(taskPlan: TaskPlanState): void {
      if (!state) return;
      state.taskPlan = taskPlan;
      if (runDir) appendJsonLine(path.join(runDir, "task-plan.jsonl"), { type: "task_plan_updated", taskPlan });
      appendEvent({ type: "task_plan_updated", taskPlan, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    // ── Swarm / subagent ledger (Campaign 1) ─────────────────────

    recordSubagentStarted(task: SubagentTaskRecord): void {
      if (!state) return;
      // Cross-run guard: a stale dispatch from an earlier run must not write
      // into the current run's ledger (C1-ADV-003).
      if (task.runId !== state.runId) {
        logDebug("state", `recordSubagentStarted ignored for task ${task.taskId}: dispatch runId ${task.runId} != current runId ${state.runId}`);
        return;
      }
      state.swarm.backend = task.backend;
      state.swarm.detectedBackend = task.detectedBackend;
      state.swarm.tasks.push(task);
      appendEvent({
        type: "subagent_started",
        task,
        backend: task.backend,
        detectedBackend: task.detectedBackend,
        timestamp: task.startedAt,
      });
    },

    recordSubagentFinished(
      taskId: string,
      finish: { runId: string; status: SubagentTaskStatus; usage?: SubagentUsageCounters | null; error?: string | null },
    ): void {
      if (!state) return;
      if (finish.runId !== state.runId) {
        logDebug("state", `recordSubagentFinished ignored for task ${taskId}: dispatch runId ${finish.runId} != current runId ${state.runId}`);
        return;
      }
      const finishedAt = new Date().toISOString();
      const task = state.swarm.tasks.find((item) => item.taskId === taskId);
      if (task) {
        task.status = finish.status;
        task.finishedAt = finishedAt;
        task.usage = finish.usage ?? null;
        task.error = finish.error ?? null;
      }
      appendEvent({
        type: "subagent_finished",
        taskId,
        status: finish.status,
        usage: finish.usage ?? null,
        error: finish.error ?? null,
        timestamp: finishedAt,
      });
    },

    // ── Sharder ledger (Campaign 2) ──────────────────────────────

    setPendingShardPlan(entry: PendingShardPlan): void {
      if (!state) return;
      // Staleness is enforced by the goal_post_shards tool's runId /
      // phaseAttemptId guard before it calls this. The proposal rides the
      // ledger (C2-OUS-002) so replay after restart rebuilds the pending
      // plan; the hook's cycle/attempt guards re-validate it there.
      state.shards.pendingPlan = entry;
      appendEvent({
        type: "shard_plan_proposed",
        entry,
        cycle: entry.cycle,
        timestamp: entry.postedAt,
      });
      persistAllInternal();
    },

    clearPendingShardPlan(): void {
      if (!state || !state.shards.pendingPlan) return;
      // Eventless by design (C2-ADV-003): the drop is re-derivable — replay
      // rebuilds the proposal and the hook's guards drop it again, so live
      // state and replayed state converge without a ledger record.
      state.shards.pendingPlan = null;
      persistAllInternal();
    },

    recordShardPlan(shardPlan: ShardPlan): void {
      if (!state) return;
      if (shardPlan.runId !== state.runId) {
        logDebug("state", `recordShardPlan ignored: plan runId ${shardPlan.runId} != current runId ${state.runId}`);
        return;
      }
      state.shards.pendingPlan = null;
      state.shards.plans.push(shardPlan);
      appendEvent({
        type: "shard_posted",
        shardPlan,
        cycle: shardPlan.cycle,
        decision: shardPlan.decision,
        timestamp: shardPlan.postedAt,
      });
    },

    // ── Scheduler claim ledger (Campaign 3, §6.5) ────────────────

    recordShardClaimed(claim: ShardClaimRecord, evidence: Record<string, unknown> = {}): void {
      if (!state) return;
      if (claim.runId !== state.runId) {
        logDebug("state", `recordShardClaimed ignored for shard ${claim.shardId}: claim runId ${claim.runId} != current runId ${state.runId}`);
        return;
      }
      // Every award is ledgered (§6.5): allocation stays auditable/replayable.
      // State keeps the latest episode per (planId, cycle, shardId) — a new
      // cycle's plan reuses plan ids, so the cycle is part of the key
      // (C3-ADV-007); the log keeps all episodes.
      const index = state.shards.claims.findIndex(
        (item) => item.planId === claim.planId && item.cycle === claim.cycle && item.shardId === claim.shardId,
      );
      if (index >= 0) state.shards.claims[index] = claim;
      else state.shards.claims.push(claim);
      appendEvent({
        type: "shard_claimed",
        shardId: claim.shardId,
        planId: claim.planId,
        cycle: claim.cycle,
        claim,
        evidence,
        timestamp: claim.claimedAt,
      });
    },

    recordShardFinished(
      shardId: string,
      finish: { runId: string; planId: string; cycle: number; status: "completed" | "failed"; taskId?: string | null; error?: string | null; patchArtifactPath?: string | null },
    ): void {
      if (!state) return;
      if (finish.runId !== state.runId) {
        logDebug("state", `recordShardFinished ignored for shard ${shardId}: finish runId ${finish.runId} != current runId ${state.runId}`);
        return;
      }
      const claim = state.shards.claims.find(
        (item) => item.planId === finish.planId && item.cycle === finish.cycle && item.shardId === shardId,
      );
      // Orphan settle (C3-ADV-008): a settle with no matching claim has no
      // state effect, so ledgering it would claim a transition nothing made —
      // skip the event and say why. Callers settle claim-then-fail instead.
      if (!claim) {
        logDebug("state", `recordShardFinished skipped for shard ${shardId} (plan ${finish.planId} cycle ${finish.cycle}): no matching claim — orphan ${finish.status} not ledgered`);
        return;
      }
      const finishedAt = new Date().toISOString();
      claim.status = finish.status;
      claim.finishedAt = finishedAt;
      claim.error = finish.status === "failed" ? (finish.error ?? null) : null;
      if (finish.taskId) claim.taskId = finish.taskId;
      // C4-OUS-001: the completed shard's patch bytes live in a run-dir
      // artifact so a crash before merge-back never strands the work; a
      // failed shard carries no merge-able patch.
      claim.patchArtifactPath = finish.status === "completed" ? (finish.patchArtifactPath ?? null) : null;
      // Figure D5 (§6.6): merge_proposed → failed on gate rejection — an open
      // merge proposal dies with the failure. Mirrors the shard_failed replay
      // handler exactly so live and replayed state converge.
      if (finish.status === "failed") {
        const merge = state.shards.merges.find(
          (item) => item.planId === finish.planId && item.cycle === finish.cycle && item.shardId === shardId,
        );
        if (merge && merge.status === "proposed") {
          merge.status = "rejected";
          merge.error = finish.error ?? null;
        }
      }
      appendEvent({
        type: finish.status === "completed" ? "shard_completed" : "shard_failed",
        shardId,
        planId: finish.planId,
        cycle: finish.cycle,
        taskId: finish.taskId ?? null,
        error: finish.status === "failed" ? (finish.error ?? null) : null,
        patchArtifactPath: claim.patchArtifactPath,
        timestamp: finishedAt,
      });
    },

    // ── Merge-back ledger (Campaign 4, §6.6) ─────────────────────

    recordMergeProposed(merge: ShardMergeRecord): void {
      if (!state) return;
      if (merge.runId !== state.runId) {
        logDebug("state", `recordMergeProposed ignored for shard ${merge.shardId}: merge runId ${merge.runId} != current runId ${state.runId}`);
        return;
      }
      // Orphan discipline (same rationale as C3-ADV-008): a merge proposal
      // for a shard with no claim record asserts a lifecycle transition the
      // ledger never saw start — skip the event and say why.
      const claim = state.shards.claims.find(
        (item) => item.planId === merge.planId && item.cycle === merge.cycle && item.shardId === merge.shardId,
      );
      if (!claim) {
        logDebug("state", `recordMergeProposed skipped for shard ${merge.shardId} (plan ${merge.planId} cycle ${merge.cycle}): no matching claim — orphan merge not ledgered`);
        return;
      }
      const index = state.shards.merges.findIndex(
        (item) => item.planId === merge.planId && item.cycle === merge.cycle && item.shardId === merge.shardId,
      );
      if (index >= 0) state.shards.merges[index] = merge;
      else state.shards.merges.push(merge);
      // shardId/planId/cycle stay top-level: the C3 error-cascade monitor
      // reads exactly those fields on shard events (C4 contract note).
      appendEvent({
        type: "merge_proposed",
        shardId: merge.shardId,
        planId: merge.planId,
        cycle: merge.cycle,
        merge,
        timestamp: merge.proposedAt,
      });
    },

    recordMergeVerified(
      shardId: string,
      verdict: {
        runId: string;
        planId: string;
        cycle: number;
        integrationCommitSha: string;
        gate: ShardMergeRecord["gate"];
        verifiedAt?: string;
      },
    ): void {
      if (!state) return;
      if (verdict.runId !== state.runId) {
        logDebug("state", `recordMergeVerified ignored for shard ${shardId}: verdict runId ${verdict.runId} != current runId ${state.runId}`);
        return;
      }
      const merge = state.shards.merges.find(
        (item) => item.planId === verdict.planId && item.cycle === verdict.cycle && item.shardId === shardId,
      );
      // A verify with no proposal has no state effect (orphan discipline,
      // C3-ADV-008) — ledgering it would claim a transition nothing made.
      if (!merge) {
        logDebug("state", `recordMergeVerified skipped for shard ${shardId} (plan ${verdict.planId} cycle ${verdict.cycle}): no matching merge proposal — orphan verify not ledgered`);
        return;
      }
      // C4-OUS-011: the caller's clock reaches verifiedAt (test injection);
      // the wall clock is only the default.
      const verifiedAt = verdict.verifiedAt ?? new Date().toISOString();
      merge.status = "verified";
      merge.verifiedAt = verifiedAt;
      merge.error = null;
      merge.gate = verdict.gate;
      merge.integrationCommitSha = verdict.integrationCommitSha;
      // Event type is exactly "merge_verified" — the C3 cascade monitor
      // heals failure episodes on it (C4 contract note).
      appendEvent({
        type: "merge_verified",
        shardId,
        planId: verdict.planId,
        cycle: verdict.cycle,
        gate: verdict.gate,
        integrationBranch: merge.integrationBranch,
        integrationCommitSha: verdict.integrationCommitSha,
        patchSha256: merge.patchSha256,
        timestamp: verifiedAt,
      });
    },

    updateDlpState(dlp: CyberDlpState): void {
      if (!state) return;
      state.dlp = dlp;
      appendEvent({ type: "dlp_state_updated", dlp, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    updateSanitizationState(sanitizer: CyberSanitizationState): void {
      if (!state) return;
      state.sanitizer = sanitizer;
      appendEvent({ type: "sanitizer_state_updated", sanitizer, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    recordAttestation(attestation: ActionAttestation): void {
      if (!state) return;
      state.attestations.push(attestation);
      if (runDir) appendJsonLine(path.join(runDir, "attestations.jsonl"), attestation as unknown as Record<string, unknown>);
      appendEvent({ type: "attestation_recorded", attestation, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    requestApproval(request: ApprovalRequest): void {
      if (!state) return;
      if (request.runId !== state.runId
        || request.cycle !== state.cycle
        || !request.phaseAttemptId
        || request.phaseAttemptId !== state.lock.activePhaseId) {
        throw new Error("approval request scope must match the active run, cycle, and phase attempt");
      }
      state.approvals.pending.push(request);
      state.status = "pending_approval";
      state.lock.phaseStatus = "paused";
      persistLock();
      if (runDir) appendJsonLine(path.join(runDir, "approvals.jsonl"), { type: "approval_requested", ...request });
      appendEvent({ type: "approval_requested", request, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    resolveApproval(token: string, status: "approved" | "denied" | "expired"): ApprovalRequest | null {
      if (!state) return null;
      const idx = state.approvals.pending.findIndex((request) => request.token === token);
      if (idx < 0) return null;
      const [request] = state.approvals.pending.splice(idx, 1);
      const now = new Date();
      const effectiveStatus = status === "approved"
        && (
          !request.expiresAt
          || !Number.isFinite(Date.parse(request.expiresAt))
          || Date.parse(request.expiresAt) <= now.getTime()
          || !request.phaseAttemptId
          || request.phaseAttemptId !== state.lock.activePhaseId
        )
        ? "expired"
        : status;
      const resolved: ApprovalRequest = {
        ...request,
        status: effectiveStatus,
        resolvedAt: now.toISOString(),
      };
      state.approvals.history.push(resolved);
      state.status = effectiveStatus === "approved" ? "running" : "policy_denied";
      state.lock.phaseStatus = effectiveStatus === "approved" ? "running" : "paused";
      persistLock();
      if (runDir) appendJsonLine(path.join(runDir, "approvals.jsonl"), { type: "approval_resolved", ...resolved });
      appendEvent({ type: "approval_resolved", request: resolved, timestamp: new Date().toISOString() });
      persistAllInternal();
      return resolved;
    },

    consumeApproval(token: string, command: string, cwd: string): { ok: true; request: ApprovalRequest } | { ok: false; reason: string } {
      if (!state) return { ok: false, reason: "no active run" };
      const request = state.approvals.history.find((item) => item.token === token);
      const validation = validateApprovalForCommand(request, {
        runId: state.runId,
        cycle: state.cycle,
        phaseAttemptId: state.lock.activePhaseId ?? "",
        command,
        cwd,
      });
      if (!validation.ok) return validation;
      const usedAt = new Date().toISOString();
      validation.request.usedAt = usedAt;
      validation.request.usedForCommand = command;
      appendEvent({ type: "approval_consumed", token, command, usedAt, timestamp: usedAt });
      if (runDir) appendJsonLine(path.join(runDir, "approvals.jsonl"), { type: "approval_consumed", token, command, usedAt });
      persistAllInternal();
      return { ok: true, request: validation.request };
    },

    setCapabilities(snapshot: CapabilitySnapshot): void {
      if (!state) return;
      state.capabilities = snapshot;
      appendEvent({ type: "capabilities_updated", capabilities: snapshot, timestamp: new Date().toISOString() });
      appendEvent({
        type: "project_instructions_updated",
        projectInstructions: state.projectInstructions,
        timestamp: new Date().toISOString(),
      });
      persistAllInternal();
    },

    setProjectInstructions(projectInstructions: ProjectInstructionsState): void {
      if (!state) return;
      state.projectInstructions = projectInstructions;
      appendEvent({
        type: "project_instructions_updated",
        projectInstructions,
        timestamp: new Date().toISOString(),
      });
      persistAllInternal();
    },

    recordError(error: IterativeGoalError): void {
      if (!state) return;
      state.errors.push(error);
      appendEvent({ type: "error_recorded", error, timestamp: new Date().toISOString() });
    },

    recordArtifact(artifact: PhaseArtifact): void {
      if (!state) return;
      const key = phaseToArtifactKey(artifact.phase);
      const arr = state.artifacts[key] as PhaseArtifact[];
      arr.push(artifact);

      // Persist phase result to run-scoped directory
      if (runDir) {
        const phaseDir = ensurePhaseDirs(artifact.cycle, artifact.phase);
        writeFileAtomic(
          path.join(phaseDir, "result.json"),
          JSON.stringify(artifact, null, 2),
        );
      }

      appendEvent({
        type: "artifact_recorded",
        artifact,
        timestamp: new Date().toISOString(),
      });
    },

    recordVerdict(verdict: EvaluatorVerdict): void {
      if (!state) return;
      state.evaluator.lastVerdict = verdict;
      state.artifacts.evaluatorReports.push(verdict);

      if (runDir) {
        const verdictsPath = path.join(runDir, "evaluator-verdicts.jsonl");
        appendJsonLine(verdictsPath, verdict as unknown as Record<string, unknown>);
      }
      appendEvent({ type: "verdict_recorded", verdict, timestamp: new Date().toISOString() });
    },

    setStatus(status: RunStatus): void {
      if (!state) return;
      state.status = status;
      if (status === "paused_by_user") {
        state.lock.phaseStatus = "paused";
        persistLock();
      }
      appendEvent({ type: "status_changed", status, timestamp: new Date().toISOString() });
      persistAllInternal();
    },

    setPhase(phase: Phase): void {
      if (!state) return;
      state.phase = phase;
      appendEvent({ type: "phase_changed", phase, timestamp: new Date().toISOString() });
    },

    incrementCycle(): void {
      if (!state) return;
      state.cycle += 1;
      appendEvent({ type: "cycle_incremented", cycle: state.cycle, timestamp: new Date().toISOString() });
    },

    markSucceeded(): void {
      if (!state) return;
      state.status = "succeeded";
      state.lock.phaseStatus = "verdict_recorded";
      persistLock();
      persistAllInternal();
      appendEvent({
        type: "goal_met",
        runId: state.runId,
        cycles: state.cycle,
        timestamp: new Date().toISOString(),
      });
    },

    markCompletedBlocked(): void {
      if (!state) return;
      state.status = "completed_external_blockers";
      state.lock.phaseStatus = "verdict_recorded";
      persistLock();
      persistAllInternal();
      appendEvent({
        type: "completed_external_blockers",
        runId: state.runId,
        cycles: state.cycle,
        timestamp: new Date().toISOString(),
      });
    },

    clear(): void {
      if (state) {
        state.lock.phaseStatus = "verdict_recorded";
        persistLock();
        // Archive active-run.json so restore can never resurrect it
        try {
          if (stateDir) {
            const activePath = path.join(stateDir, "active-run.json");
            if (fs.existsSync(activePath)) {
              const archiveDir = path.join(stateDir, "legacy");
              fs.mkdirSync(archiveDir, { recursive: true });
              fs.renameSync(activePath, path.join(archiveDir, `active-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
            }
          }
        } catch {}
      }
      state = null;
    },

    persistAll(): void {
      if (!state) return;
      persistToSession();
      persistToDisk();
      updateLatestMd();
    },

    getEventsPath(): string {
      return runEventsPath();
    },

    replayActiveState(): IterativeGoalState | null {
      const replayed = replayEvents(runEventsPath());
      return replayed ? migrateState(replayed) : null;
    },

    restore(ctx: ExtensionContext): IterativeGoalState | null {
      initStateDir(ctx.cwd);

      // Event log is authoritative for new runs. Legacy snapshots remain a fallback.
      if (stateDir) {
        const activeRunPath = path.join(stateDir, "active-run.json");
        let activeRunId: string | null = null;
        if (fs.existsSync(activeRunPath)) {
          try {
            const lock: RunLock = JSON.parse(fs.readFileSync(activeRunPath, "utf-8"));
            activeRunId = lock.activeRunId;
          } catch { /* ignore */ }
        }

        if (activeRunId) {
          runDir = path.join(stateDir, "runs", activeRunId);
          const activeEventsPath = path.join(runDir, "events.jsonl");
          const replayed = replayEvents(activeEventsPath);
          if (replayed) {
            state = migrateState(replayed);
            ensureRunDirs();
            reconcileAfterRestore();
            persistToDisk();
            updateLatestMd();
            return state;
          }
          if (eventsRequireReplay(activeEventsPath)) return null;
          const statePath = path.join(runDir, "state.json");
          if (fs.existsSync(statePath)) {
            try {
              const envelope = JSON.parse(fs.readFileSync(statePath, "utf-8")) as PersistenceEnvelope;
              if (envelope.state) {
                state = migrateState(envelope.state);
                ensureRunDirs();
                reconcileAfterRestore();
                return state;
              }
            } catch { /* corrupted, ignore */ }
          }
        }

        // Fall back: scan runs directory for the latest replayable run first.
        const runsDir = path.join(stateDir, "runs");
        if (fs.existsSync(runsDir)) {
          const runs = fs.readdirSync(runsDir);
          runs.sort().reverse();
          for (const runId of runs) {
            runDir = path.join(runsDir, runId);
            const replayed = replayEvents(path.join(runDir, "events.jsonl"));
            if (replayed) {
              state = migrateState(replayed);
              ensureRunDirs();
              reconcileAfterRestore();
              persistToDisk();
              updateLatestMd();
              return state;
            }
          }
          for (const runId of runs) {
            const sp = path.join(runsDir, runId, "state.json");
            if (!fs.existsSync(sp)) continue;
            try {
              const envelope = JSON.parse(fs.readFileSync(sp, "utf-8")) as PersistenceEnvelope;
              if (envelope.state) {
                state = migrateState(envelope.state);
                runDir = path.join(runsDir, runId);
                ensureRunDirs();
                reconcileAfterRestore();
                return state;
              }
            } catch { /* continue */ }
          }
        }
      }

      // Final legacy fallback: session entries.
      const entries = ctx.sessionManager.getEntries();
      const lastEntry = [...entries]
        .reverse()
        .find(e => (e as any).customType === PERSISTENCE_TYPE);

      if (lastEntry && (lastEntry as any).details) {
        const envelope = (lastEntry as any).details as PersistenceEnvelope;
        if (envelope.state) {
          state = migrateState(envelope.state);
          stateDir = path.join(ctx.cwd, ".pi", "iterative-goal");
          if (state.runId) {
            ensureRunDirs();
            reconcileAfterRestore();
            persistToDisk();
            updateLatestMd();
          }
          return state;
        }
      }

      return null;
    },
  };
}
