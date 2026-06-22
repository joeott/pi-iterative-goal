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
  PHASE_ORDER,
} from "./types.js";
import {
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODELS,
  filterAllowedModels,
  normalizeConfiguredModel,
} from "./domain/models.js";

const PERSISTENCE_TYPE = "iterative-goal-state";
const DEFAULT_AWS_CLI_CONFIG = {
  enabled: false,
  defaultRegion: "us-east-1",
  profileResolutionOrder: ["explicit", "env", "unify", "unify-old"],
  requireSessionManagerPlugin: true,
  allowMutatingFamilies: [],
  preflight: null,
} as const;

export interface StateManagerAPI {
  getState(): IterativeGoalState | null;
  isActive(): boolean;
  isPaused(): boolean;
  createRun(goal: string, goalCriterion: string, config?: Partial<IterativeGoalState["config"]>): IterativeGoalState;
  setCapabilities(snapshot: CapabilitySnapshot): void;
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
    capabilities_updated(replayed, event) {
      replayed.capabilities = event.capabilities;
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
        allowMutatingFamilies: [...DEFAULT_AWS_CLI_CONFIG.allowMutatingFamilies],
      };
    } else {
      raw.config.awsCli = {
        ...DEFAULT_AWS_CLI_CONFIG,
        ...raw.config.awsCli,
        profileResolutionOrder: Array.isArray(raw.config.awsCli.profileResolutionOrder)
          ? [...raw.config.awsCli.profileResolutionOrder]
          : [...DEFAULT_AWS_CLI_CONFIG.profileResolutionOrder],
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
    raw.version = 2;
    return raw as IterativeGoalState;
  }

  function persistToSession(): void {
    if (!state) return;
    const envelope: PersistenceEnvelope = {
      version: 2,
      state,
      updatedAt: new Date().toISOString(),
    };
    pi.appendEntry(PERSISTENCE_TYPE, envelope);
  }

  function persistToDisk(): void {
    if (!state || !runDir) return;
    const statePath = path.join(runDir, "state.json");
    const envelope: PersistenceEnvelope = {
      version: 2,
      state,
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
      ``,
      `## Lock`,
      ``,
      `- **Active Run**: ${s.lock.activeRunId ?? "none"}`,
      `- **Active Phase**: ${s.lock.activePhaseId ?? "none"}`,
      `- **Phase Status**: ${s.lock.phaseStatus}`,
      `- **Queued Phase IDs**: [${s.lock.queuedPhaseIds.join(", ")}]`,
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

    createRun(goal: string, goalCriterion: string, config?: Partial<IterativeGoalState["config"]>): IterativeGoalState {
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
            allowMutatingFamilies: config?.awsCli?.allowMutatingFamilies
              ? [...config.awsCli.allowMutatingFamilies]
              : [...DEFAULT_AWS_CLI_CONFIG.allowMutatingFamilies],
          },
        },
        capabilities: null,
        errors: [],
        artifacts: {
          research: [],
          plans: [],
          implementations: [],
          validations: [],
          evaluatorReports: [],
        },
        constraints: {
          neverStopUntilEvaluatorGoalMet: true,
          requireAllFourPhasesEachCycle: true,
          allowDestructiveOps: false,
          allowGitFinalization: false,
          requireOperatorApprovalForDangerousOps: true,
          subagentTimeoutMs: 300_000,
        },
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
      };

      ensureRunDirs();
      persistLock();
      persistAllInternal();
      appendEvent({
        type: "run_created",
        runId,
        goal,
        goalCriterion,
        initialState: state,
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

    setCapabilities(snapshot: CapabilitySnapshot): void {
      if (!state) return;
      state.capabilities = snapshot;
      appendEvent({ type: "capabilities_updated", capabilities: snapshot, timestamp: new Date().toISOString() });
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
