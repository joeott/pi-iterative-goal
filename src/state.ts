/**
 * State management and persistence for iterative-goal.
 *
 * Uses a factory function (not a class) to avoid jiti cross-module
 * class prototype resolution issues.
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
  restore(ctx: ExtensionContext): IterativeGoalState | null;
}

export function nextPhase(current: Phase): Phase {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return "research";
  return PHASE_ORDER[idx + 1];
}

export function createStateManager(pi: ExtensionAPI): StateManagerAPI {
  let state: IterativeGoalState | null = null;
  let stateDir = "";

  function phaseToArtifactKey(phase: Phase): keyof IterativeGoalState["artifacts"] {
    switch (phase) {
      case "research": return "research";
      case "plan": return "plans";
      case "implement": return "implementations";
      case "validate": return "validations";
    }
  }

  function appendEvent(event: Record<string, unknown>): void {
    if (!stateDir) return;
    const eventsPath = path.join(stateDir, "events.jsonl");
    fs.appendFileSync(eventsPath, JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n");
  }

  function persistToSession(): void {
    if (!state) return;
    const envelope: PersistenceEnvelope = {
      version: 1,
      state,
      updatedAt: new Date().toISOString(),
    };
    pi.appendEntry(PERSISTENCE_TYPE, envelope);
  }

  function persistToDisk(): void {
    if (!state || !stateDir) return;
    const statePath = path.join(stateDir, "state.json");
    const envelope: PersistenceEnvelope = {
      version: 1,
      state,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, JSON.stringify(envelope, null, 2));
  }

  function updateLatestMd(): void {
    if (!state || !stateDir) return;

    const s = state;
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

    const latestPath = path.join(stateDir, "latest.md");
    fs.writeFileSync(latestPath, lines.join("\n"));
  }

  function initStateDir(cwd: string): void {
    stateDir = path.join(cwd, ".pi", "iterative-goal");
    fs.mkdirSync(stateDir, { recursive: true });

    const eventsPath = path.join(stateDir, "events.jsonl");
    if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "");

    const verdictsPath = path.join(stateDir, "evaluator-verdicts.jsonl");
    if (!fs.existsSync(verdictsPath)) fs.writeFileSync(verdictsPath, "");
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

    createRun(goal: string, goalCriterion: string, config?: Partial<IterativeGoalState["config"]>): IterativeGoalState {
      const runId = `ig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      state = {
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
          allowGitFinalization: false,
          requireOperatorApprovalForDangerousOps: true,
          subagentTimeoutMs: 300_000,
        },
      };

      persistAll();
      appendEvent({
        type: "run_created",
        runId,
        goal,
        timestamp: new Date().toISOString(),
      });

      return state;
    },

    setCapabilities(snapshot: CapabilitySnapshot): void {
      if (!state) return;
      state.capabilities = snapshot;
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

      if (stateDir) {
        const verdictsPath = path.join(stateDir, "evaluator-verdicts.jsonl");
        fs.appendFileSync(verdictsPath, JSON.stringify(verdict) + "\n");
      }
    },

    setStatus(status: RunStatus): void {
      if (!state) return;
      state.status = status;
      persistAll();
    },

    setPhase(phase: Phase): void {
      if (!state) return;
      state.phase = phase;
    },

    incrementCycle(): void {
      if (!state) return;
      state.cycle += 1;
    },

    markSucceeded(): void {
      if (!state) return;
      state.status = "succeeded";
      persistAll();
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
      persistAll();
      appendEvent({
        type: "completed_external_blockers",
        runId: state.runId,
        cycles: state.cycle,
        timestamp: new Date().toISOString(),
      });
    },

    clear(): void {
      state = null;
      if (stateDir && fs.existsSync(stateDir)) {
        const statePath = path.join(stateDir, "state.json");
        if (fs.existsSync(statePath)) {
          const data = fs.readFileSync(statePath, "utf-8");
          const envelope = JSON.parse(data) as PersistenceEnvelope;
          if (envelope.state) {
            envelope.state.status = "succeeded";
            fs.writeFileSync(statePath, JSON.stringify(envelope, null, 2));
          }
        }
      }
    },

    persistAll(): void {
      if (!state) return;
      persistToSession();
      persistToDisk();
      updateLatestMd();
    },

    restore(ctx: ExtensionContext): IterativeGoalState | null {
      initStateDir(ctx.cwd);

      const entries = ctx.sessionManager.getEntries();
      const lastEntry = [...entries]
        .reverse()
        .find(e => (e as any).customType === PERSISTENCE_TYPE);

      if (lastEntry && (lastEntry as any).details) {
        const envelope = (lastEntry as any).details as PersistenceEnvelope;
        if (envelope.state) {
          state = envelope.state;
          stateDir = path.join(ctx.cwd, ".pi", "iterative-goal");
          persistToDisk();
          updateLatestMd();
          return state;
        }
      }

      if (stateDir) {
        const statePath = path.join(stateDir, "state.json");
        if (fs.existsSync(statePath)) {
          const data = fs.readFileSync(statePath, "utf-8");
          try {
            const envelope = JSON.parse(data) as PersistenceEnvelope;
            if (envelope.state) {
              state = envelope.state;
              return state;
            }
          } catch { /* corrupted, ignore */ }
        }
      }

      return null;
    },
  };

  function persistAll(): void {
    if (!state) return;
    persistToSession();
    persistToDisk();
    updateLatestMd();
  }
}
