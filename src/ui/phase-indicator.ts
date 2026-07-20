/**
 * Phase indicator — single owner of all goal/phase rendering.
 *
 * Consolidates the status bar, widget, header goal line, and the live
 * dashboard projection into one module (deployment plan Ch. 4). The
 * StateManager version counter (incremented inside appendEvent) is the
 * invalidation signal; a 1 Hz ticker — the first setInterval in src/,
 * added deliberately — polls it and pushes surfaces explicitly, so
 * rendering never depends on unverified ctx.ui.setHeader re-render
 * semantics.
 *
 * Refresh asymmetry (cost/flicker trade-off): the single-line status
 * bar and header repaint every tick while a phase attempt is active so
 * {elapsed} advances at one-second granularity; the multi-line widget
 * repaints on version-changed ticks only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StateManagerAPI } from "../state.js";
import {
  type EvaluatorVerdict,
  type IterativeGoalError,
  type IterativeGoalState,
  type Phase,
  type RunStatus,
  PHASE_ORDER,
} from "../types.js";

/** Header component factory, as accepted by ctx.ui.setHeader. */
export type HeaderFactory = NonNullable<Parameters<ExtensionContext["ui"]["setHeader"]>[0]>;

// ── Phase icon and color (shared by every surface) ─────────────────

export function phaseIcon(phase: string): string {
  switch (phase) {
    case "research": return "🔍";
    case "plan": return "📋";
    case "implement": return "🔧";
    case "validate": return "✅";
    default: return "•";
  }
}

export function statusIcon(status: string): string {
  switch (status) {
    case "running": return "▶";
    case "paused_by_user": return "⏸";
    case "recovering": return "🔄";
    case "succeeded": return "✓";
    case "completed_external_blockers": return "⊘";
    case "pending_approval": return "⏸";
    default: return "•";
  }
}

// ── Render model (pure projection, testable without a terminal) ────

export interface RenderModel {
  goal: string;
  cycle: number;
  phase: Phase;
  status: RunStatus;
  elapsed: string; // mm:ss in current phase
  taskDone: number;
  taskTotal: number;
  inProgressTask: string | null;
  /** Dormant until Chapter 6's shard_posted/shard_completed events land. */
  shards: { done: number; total: number } | null;
  evaluator: { status: string; warn: boolean; heartbeatAgeS: number | null } | null;
  verdict: EvaluatorVerdict | null;
  blockers: string[];
  errors: IterativeGoalError[];
  progressPct: number;
}

export function renderModel(state: IterativeGoalState, now: number = Date.now()): RenderModel {
  const items = state.taskPlan.items.filter((item) => item.status !== "cancelled");
  const es = state.evaluatorState;
  const verdict = state.evaluator.lastVerdict ?? null;
  return {
    goal: state.goal,
    cycle: state.cycle,
    phase: state.phase,
    status: state.status,
    elapsed: formatElapsed(elapsedMs(state, now)),
    taskDone: items.filter((item) => item.status === "completed").length,
    taskTotal: items.length,
    inProgressTask: state.taskPlan.items.find((item) => item.status === "in_progress")?.title ?? null,
    shards: null,
    evaluator: es
      ? {
        status: es.status,
        warn: es.status === "stale_heartbeat" || es.status === "error",
        heartbeatAgeS: es.lastHeartbeatAt
          ? Math.max(0, Math.round((now - Date.parse(es.lastHeartbeatAt)) / 1000))
          : null,
      }
      : null,
    verdict,
    blockers: verdict ? verdict.completion_blockers.slice(0, 2) : [],
    errors: state.errors.filter((e) => !e.resolved).slice(-2),
    progressPct: calculateProgress(state),
  };
}

/** mm:ss from Date.now() − lock.phaseStartedAt, falling back to the open PhaseAttempt.startedAt. */
function elapsedMs(state: IterativeGoalState, now: number): number {
  const openAttempt = [...state.phaseAttempts].reverse().find((a) => a.status === "running");
  const startedAt = state.lock.phaseStartedAt || openAttempt?.startedAt || "";
  const ms = startedAt ? now - Date.parse(startedAt) : 0;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * pct = round(100·(i + f)/4), where i is the phase index in the
 * four-phase cycle and f is taskPlan completed/total during implement.
 * Monotonic within a cycle; renders 100% only on goal_met (G5).
 */
export function calculateProgress(state: IterativeGoalState): number {
  if (state.evaluator.lastVerdict?.goal_met) return 100;
  const idx = Math.max(0, PHASE_ORDER.indexOf(state.phase));
  const items = state.taskPlan.items.filter((item) => item.status !== "cancelled");
  const f = state.phase === "implement" && items.length > 0
    ? items.filter((item) => item.status === "completed").length / items.length
    : 0;
  return Math.round((100 * (idx + f)) / 4);
}

// ── Per-surface formatters ──────────────────────────────────────────

function evalDisplay(model: RenderModel): string {
  if (!model.evaluator) return "no eval";
  return model.evaluator.warn ? `⚠ ${model.evaluator.status}` : model.evaluator.status;
}

export function formatStatusLine(model: RenderModel): string {
  const parts = [
    `🎯 C${model.cycle} ${phaseIcon(model.phase)} ${model.phase} ${model.elapsed}`,
    `task ${model.taskDone}/${model.taskTotal}`,
  ];
  if (model.shards) parts.push(`shards ${model.shards.done}/${model.shards.total}`);
  parts.push(`eval ${evalDisplay(model)}`);
  return parts.join(" · ");
}

export function formatWidgetLines(model: RenderModel): string[] {
  const lines: string[] = [];
  lines.push(`🎯 ${model.goal.slice(0, 60)}${model.goal.length > 60 ? "..." : ""}`);
  lines.push(`C${model.cycle} ${phaseIcon(model.phase)} ${model.phase} · ${model.status}`);
  if (model.inProgressTask) {
    lines.push(`▸ ${model.inProgressTask}`);
  }
  if (model.evaluator) {
    const heartbeat = model.evaluator.heartbeatAgeS !== null ? ` · hb ${model.evaluator.heartbeatAgeS}s` : "";
    lines.push(`eval ${evalDisplay(model)}${heartbeat}`);
  }
  if (model.verdict) {
    const v = model.verdict;
    lines.push(`Eval: ${v.goal_met ? "✓ met" : "✗ not met"} (conf: ${Math.round(v.confidence * 100)}%)`);
    if (v.next_cycle_directive.focus) {
      lines.push(`Next: ${v.next_cycle_directive.focus}`);
    }
  }
  for (const b of model.blockers) {
    lines.push(`  ⚠ ${b.slice(0, 50)}`);
  }
  for (const e of model.errors) {
    lines.push(`  ❌ [${e.phase}] ${e.kind}${e.missingTool ? ":" + e.missingTool : ""}`);
  }
  return lines;
}

export function formatHeaderGoalLine(model: RenderModel): string {
  return `goal: C${model.cycle} ${phaseIcon(model.phase)} ${model.phase} ${model.status} ${model.elapsed}`;
}

/** Live goal line for HarnessHeader; null when no run is active. */
export function headerGoalLine(stateManager: StateManagerAPI, now?: number): string | null {
  const state = stateManager.getState();
  return state ? formatHeaderGoalLine(renderModel(state, now)) : null;
}

// stateManager.clear() appends no event, so the version feed never fires
// after /goal-reset — hence this imperative rendered-empty clear.
function clearPhaseSurfaces(ctx: ExtensionContext, headerFactory: HeaderFactory | null): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("iterative-goal", undefined);
  ctx.ui.setWidget("iterative-goal", undefined);
  if (headerFactory) ctx.ui.setHeader(headerFactory);
}

// ── 1 Hz ticker ─────────────────────────────────────────────────────

export interface PhaseIndicatorDeps {
  stateManager: StateManagerAPI;
  getContext(): ExtensionContext | null;
  getHeaderFactory(): HeaderFactory | null;
  getDashboard(): { invalidate(): void } | null;
}

export interface PhaseIndicatorTicker {
  tickOnce(now?: number): void;
}

export function createPhaseIndicatorTicker(deps: PhaseIndicatorDeps): PhaseIndicatorTicker {
  let lastVersion = -1; // forces one render on the first tick

  function tickOnce(now: number = Date.now()): void {
    const ctx = deps.getContext();
    if (!ctx || !ctx.hasUI) return;
    const version = deps.stateManager.getVersion();
    const versionChanged = version !== lastVersion;
    if (!versionChanged && !isPhaseAttemptActive(deps.stateManager.getState())) {
      return; // paused or idle: one integer comparison, nothing emitted
    }
    lastVersion = version;
    pushSurfaces(ctx, deps.stateManager.getState(), now, versionChanged);
  }

  function pushSurfaces(
    ctx: ExtensionContext,
    state: IterativeGoalState | null,
    now: number,
    versionChanged: boolean,
  ): void {
    const headerFactory = deps.getHeaderFactory();
    if (!state) {
      clearPhaseSurfaces(ctx, headerFactory);
      return;
    }
    const model = renderModel(state, now);
    ctx.ui.setStatus("iterative-goal", formatStatusLine(model));
    // Explicit push per invalidating tick — no reliance on framework
    // header re-render semantics (the factory reads state lazily).
    if (headerFactory) ctx.ui.setHeader(headerFactory);
    if (versionChanged) {
      ctx.ui.setWidget("iterative-goal", formatWidgetLines(model), { placement: "belowEditor" });
      deps.getDashboard()?.invalidate();
    }
  }

  return { tickOnce };
}

function isPhaseAttemptActive(state: IterativeGoalState | null): boolean {
  if (!state || state.status !== "running") return false;
  return state.lock.phaseStatus === "running" && state.lock.activePhaseId !== null;
}

// ── Extension registration ──────────────────────────────────────────

export interface PhaseIndicatorHandle {
  tickOnce(now?: number): void;
  stop(): void;
  clearSurfaces(ctx: ExtensionContext): void;
  setHeaderFactory(factory: HeaderFactory | null): void;
  trackDashboard(dashboard: { invalidate(): void } | null): void;
}

export function registerPhaseIndicator(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
): PhaseIndicatorHandle {
  let ctx: ExtensionContext | null = null;
  let headerFactory: HeaderFactory | null = null;
  let dashboard: { invalidate(): void } | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let ticker: PhaseIndicatorTicker | null = null;

  function teardown(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    ticker = null;
    ctx = null;
  }

  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    // restore() replays without appending events, so the version counter
    // alone cannot surface a restored run — render it on the first tick.
    if (!stateManager.getState()) stateManager.restore(sessionCtx);
    // Fresh ticker per session: a warm in-process restart (new/resume/
    // fork/reload) must not inherit lastVersion, or a restored
    // non-running run would never repaint — restore() bumps nothing.
    ticker = createPhaseIndicatorTicker({
      stateManager,
      getContext: () => ctx,
      getHeaderFactory: () => headerFactory,
      getDashboard: () => dashboard,
    });
    ticker.tickOnce();
    if (interval) clearInterval(interval);
    interval = setInterval(() => ticker?.tickOnce(), 1000);
    // UI-only timer: must not pin the Node event loop in headless/one-shot sessions.
    interval.unref?.();
  });

  pi.on("session_shutdown", async () => {
    teardown();
  });

  return {
    tickOnce: (now?: number) => ticker?.tickOnce(now),
    stop(): void {
      teardown();
    },
    clearSurfaces(sessionCtx: ExtensionContext): void {
      clearPhaseSurfaces(sessionCtx, headerFactory);
    },
    setHeaderFactory(factory: HeaderFactory | null): void {
      headerFactory = factory;
    },
    trackDashboard(next: { invalidate(): void } | null): void {
      dashboard = next;
    },
  };
}
