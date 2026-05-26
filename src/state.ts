/**
 * State management and persistence for iterative-goal.
 *
 * Stores state in:
 *   .pi/iterative-goal/state.json      – full machine-readable state
 *   .pi/iterative-goal/events.jsonl    – append-only event log
 *   .pi/iterative-goal/latest.md       – human-readable summary
 *   .pi/iterative-goal/evaluator-verdicts.jsonl – evaluator verdicts
 *
 * Also uses pi.appendEntry() for session-level checkpoints
 * that survive compaction.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
  PHASE_ORDER,
} from "./types.js";

const PERSISTENCE_TYPE = "iterative-goal-state";

export class StateManager {
  private state: IterativeGoalState | null = null;
  private stateDir: string;

  constructor(private pi: ExtensionAPI) {
    this.stateDir = "";
  }

  // ── Public API ────────────────────────────────────────────────────

  getState(): IterativeGoalState | null {
    return this.state;
  }

  isActive(): boolean {
    return this.state !== null && this.state.status === "running";
  }

  isPaused(): boolean {
    return this.state !== null && this.state.status === "paused_by_user";
  }

  /** Initialize a new goal run */
  createRun(goal: string, goalCriterion: string, config?: Partial<IterativeGoalState["config"]>): IterativeGoalState {
    const runId = `ig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.state = {
      version: 1,
      runId,
      goal,
      goalCriterion,
      mode: "auto_until_external_evaluator_success",
      status: "running",
      cycle: 1,
      phase: "research",
      requiredPhaseOrder: PHASE_ORDER,
      evaluator: {
        model: config?.primaryModel?.model ?? "claude-sonnet-4-5",
        provider: config?.primaryModel?.provider ?? "anthropic",
        completionRequiresEvaluator: true,
      },
      config: {
        primaryModel: config?.primaryModel ?? { provider: "anthropic", model: "claude-sonnet-4-5" },
        fallbackModels: config?.fallbackModels ?? [],
        blockedModels: config?.blockedModels ?? [],
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
        requireOperatorApprovalForDangerousOps: true,
      },
    };

    this.persistAll();
    this.appendEvent({
      type: "run_created",
      runId,
      goal,
      timestamp: new Date().toISOString(),
    });

    return this.state;
  }

  setCapabilities(snapshot: CapabilitySnapshot): void {
    if (!this.state) return;
    this.state.capabilities = snapshot;
  }

  recordError(error: IterativeGoalError): void {
    if (!this.state) return;
    this.state.errors.push(error);
    this.appendEvent({ type: "error_recorded", error, timestamp: new Date().toISOString() });
  }

  recordArtifact(artifact: PhaseArtifact): void {
    if (!this.state) return;
    const key = this.phaseToArtifactKey(artifact.phase);
    const arr = this.state.artifacts[key] as PhaseArtifact[];
    arr.push(artifact);
    this.appendEvent({
      type: "artifact_recorded",
      artifact,
      timestamp: new Date().toISOString(),
    });
  }

  recordVerdict(verdict: EvaluatorVerdict): void {
    if (!this.state) return;
    this.state.evaluator.lastVerdict = verdict;
    this.state.artifacts.evaluatorReports.push(verdict);

    // Append to evaluator verdicts file
    if (this.stateDir) {
      const verdictsPath = path.join(this.stateDir, "evaluator-verdicts.jsonl");
      fs.appendFileSync(verdictsPath, JSON.stringify(verdict) + "\n");
    }
  }

  setStatus(status: RunStatus): void {
    if (!this.state) return;
    this.state.status = status;
    this.persistAll();
  }

  setPhase(phase: Phase): void {
    if (!this.state) return;
    this.state.phase = phase;
  }

  incrementCycle(): void {
    if (!this.state) return;
    this.state.cycle += 1;
  }

  markSucceeded(): void {
    if (!this.state) return;
    this.state.status = "succeeded";
    this.persistAll();
    this.appendEvent({
      type: "goal_met",
      runId: this.state.runId,
      cycles: this.state.cycle,
      timestamp: new Date().toISOString(),
    });
  }

  clear(): void {
    this.state = null;
    if (this.stateDir && fs.existsSync(this.stateDir)) {
      const statePath = path.join(this.stateDir, "state.json");
      if (fs.existsSync(statePath)) {
        const data = fs.readFileSync(statePath, "utf-8");
        const envelope = JSON.parse(data) as PersistenceEnvelope;
        if (envelope.state) {
          envelope.state.status = "succeeded";
          fs.writeFileSync(statePath, JSON.stringify(envelope, null, 2));
        }
      }
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  /** Full persist to all layers */
  persistAll(): void {
    if (!this.state) return;
    this.persistToSession();
    this.persistToDisk();
    this.updateLatestMd();
  }

  /** Session-level checkpoint via appendEntry */
  persistToSession(): void {
    if (!this.state) return;
    const envelope: PersistenceEnvelope = {
      version: 1,
      state: this.state,
      updatedAt: new Date().toISOString(),
    };
    this.pi.appendEntry(PERSISTENCE_TYPE, envelope);
  }

  /** Disk-level persistence for compaction recovery */
  persistToDisk(): void {
    if (!this.state || !this.stateDir) return;

    const statePath = path.join(this.stateDir, "state.json");
    const envelope: PersistenceEnvelope = {
      version: 1,
      state: this.state,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, JSON.stringify(envelope, null, 2));
  }

  /** Write human-readable summary */
  updateLatestMd(): void {
    if (!this.state || !this.stateDir) return;

    const s = this.state;
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
      `## Evaluator`,
      ``,
      `- **Model**: ${s.evaluator.provider}/${s.evaluator.model}`,
      `- **Last Verdict**: ${s.evaluator.lastVerdict ? `goal_met=${s.evaluator.lastVerdict.goal_met}, confidence=${s.evaluator.lastVerdict.confidence}` : "none yet"}`,
      ``,
      `## Artifacts`,
      ``,
      `- Research: ${s.artifacts.research.length}`,
      `- Plans: ${s.artifacts.plans.length}`,
      `- Implementations: ${s.artifacts.implementations.length}`,
      `- Validations: ${s.artifacts.validations.length}`,
      `- Evaluator Reports: ${s.artifacts.evaluatorReports.length}`,
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

    const latestPath = path.join(this.stateDir, "latest.md");
    fs.writeFileSync(latestPath, lines.join("\n"));
  }

  /** Append to events JSONL */
  appendEvent(event: Record<string, unknown>): void {
    if (!this.stateDir) return;
    const eventsPath = path.join(this.stateDir, "events.jsonl");
    fs.appendFileSync(eventsPath, JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n");
  }

  // ── Restoration ────────────────────────────────────────────────────

  /** Initialize state directory for a project */
  initStateDir(cwd: string): void {
    this.stateDir = path.join(cwd, ".pi", "iterative-goal");
    fs.mkdirSync(this.stateDir, { recursive: true });

    // Create files if they don't exist
    const eventsPath = path.join(this.stateDir, "events.jsonl");
    if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "");

    const verdictsPath = path.join(this.stateDir, "evaluator-verdicts.jsonl");
    if (!fs.existsSync(verdictsPath)) fs.writeFileSync(verdictsPath, "");
  }

  /** Restore from session (on session_start) */
  restore(ctx: ExtensionContext): IterativeGoalState | null {
    this.initStateDir(ctx.cwd);

    // First try session entries
    const entries = ctx.sessionManager.getEntries();
    const lastEntry = [...entries]
      .reverse()
      .find(e => (e as any).customType === PERSISTENCE_TYPE);

    if (lastEntry && (lastEntry as any).details) {
      const envelope = (lastEntry as any).details as PersistenceEnvelope;
      if (envelope.state) {
        this.state = envelope.state;
        this.stateDir = path.join(ctx.cwd, ".pi", "iterative-goal");
        // Refresh disk state
        this.persistToDisk();
        this.updateLatestMd();
        return this.state;
      }
    }

    // Fallback: try disk
    if (this.stateDir) {
      const statePath = path.join(this.stateDir, "state.json");
      if (fs.existsSync(statePath)) {
        const data = fs.readFileSync(statePath, "utf-8");
        try {
          const envelope = JSON.parse(data) as PersistenceEnvelope;
          if (envelope.state) {
            this.state = envelope.state;
            return this.state;
          }
        } catch { /* corrupted, ignore */ }
      }
    }

    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private phaseToArtifactKey(phase: Phase): keyof IterativeGoalState["artifacts"] {
    switch (phase) {
      case "research": return "research";
      case "plan": return "plans";
      case "implement": return "implementations";
      case "validate": return "validations";
    }
  }

  /** Get the next phase in the fixed order */
  static nextPhase(current: Phase): Phase {
    const idx = PHASE_ORDER.indexOf(current);
    if (idx < 0 || idx >= PHASE_ORDER.length - 1) return "research"; // wrap
    return PHASE_ORDER[idx + 1];
  }
}