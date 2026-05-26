/**
 * Dashboard UI - TUI display for iterative-goal status.
 *
 * Shows cycle, phase, blockers, evaluator verdict, error history,
 * and active recommendations. Mirrors the pi-autoresearch dashboard.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, Box, Spacer } from "@mariozechner/pi-tui";
import type { IterativeGoalState, PhaseArtifact } from "./types.js";
import { PHASE_ORDER } from "./types.js";
import { type StateManager } from "./state.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Phase icon and color ────────────────────────────────────────────

function phaseIcon(phase: string): string {
  switch (phase) {
    case "research": return "🔍";
    case "plan": return "📋";
    case "implement": return "🔧";
    case "validate": return "✅";
    default: return "•";
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "running": return "▶";
    case "paused_by_user": return "⏸";
    case "recovering": return "🔄";
    case "succeeded": return "✓";
    default: return "•";
  }
}

// ── Dashboard component ─────────────────────────────────────────────

class DashboardComponent {
  private state: IterativeGoalState | null;
  private stateManager: StateManager;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(state: IterativeGoalState | null, stateManager: StateManager, onClose: () => void) {
    this.state = state;
    this.stateManager = stateManager;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    // Escape / Ctrl+C to close
    if (data === "\x1b" || data === "\x03") {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    const W = Math.max(30, width - 2);

    if (!this.state) {
      lines.push("");
      lines.push("  No active iterative goal.");
      lines.push("  Start one with: /goal-start <description>");
      lines.push("");
      this.cachedLines = lines;
      this.cachedWidth = width;
      return lines;
    }

    const s = this.state;

    // Header
    lines.push("");
    lines.push(`  ╔${"═".repeat(Math.min(W - 4, 56))}╗`);
    lines.push(`  ║ ${padRight(`iterative-goal  ${statusIcon(s.status)} ${s.status}`, W - 8)}  ║`);
    lines.push(`  ╠${"═".repeat(Math.min(W - 4, 56))}╣`);

    // Goal
    lines.push(`  ║ ${padRight(`Goal: ${s.goal.slice(0, W - 12)}`, W - 8)}  ║`);

    // Stats row
    const stats = `Cycle: ${s.cycle}  |  Phase: ${phaseIcon(s.phase)} ${s.phase}`;
    lines.push(`  ║ ${padRight(stats, W - 8)}  ║`);

    // Evaluator
    const evalInfo = s.evaluator.lastVerdict
      ? `Evaluator: goal_met=${s.evaluator.lastVerdict.goal_met}, confidence=${s.evaluator.lastVerdict.confidence}`
      : `Evaluator: no verdict yet`;
    lines.push(`  ║ ${padRight(evalInfo, W - 8)}  ║`);

    lines.push(`  ╠${"═".repeat(Math.min(W - 4, 56))}╣`);

    // Artifact counts
    const artCounts = [
      `R:${s.artifacts.research.length}`,
      `P:${s.artifacts.plans.length}`,
      `I:${s.artifacts.implementations.length}`,
      `V:${s.artifacts.validations.length}`,
      `Eval:${s.artifacts.evaluatorReports.length}`,
    ].join("  ");
    lines.push(`  ║ ${padRight(`Artifacts: ${artCounts}`, W - 8)}  ║`);
    lines.push(`  ║ ${padRight(`Errors: ${s.errors.length}`, W - 8)}  ║`);

    // Recent errors
    const recentErrors = s.errors.slice(-5);
    if (recentErrors.length > 0) {
      lines.push(`  ╠${"─".repeat(Math.min(W - 4, 56))}╣`);
      lines.push(`  ║ ${padRight("Recent Errors:", W - 8)}  ║`);
      for (const err of recentErrors) {
        const errLine = `  [${err.phase}] ${err.kind}${err.missingTool ? ":" + err.missingTool : ""} ${err.resolved ? "✓" : ""}`;
        lines.push(`  ║ ${padRight(errLine.slice(0, W - 10), W - 8)}  ║`);
      }
    }

    // Evaluator verdict summary
    if (s.evaluator.lastVerdict) {
      const v = s.evaluator.lastVerdict;
      lines.push(`  ╠${"─".repeat(Math.min(W - 4, 56))}╣`);
      lines.push(`  ║ ${padRight("Last Evaluator Verdict:", W - 8)}  ║`);

      if (v.completion_blockers.length > 0) {
        lines.push(`  ║ ${padRight(`Blockers (${v.completion_blockers.length}):`, W - 8)}  ║`);
        for (const b of v.completion_blockers.slice(0, 3)) {
          lines.push(`  ║   • ${padRight(b.slice(0, W - 14), W - 14)}  ║`);
        }
      }

      if (v.remaining_work.length > 0) {
        lines.push(`  ║ ${padRight(`Remaining Work:`, W - 8)}  ║`);
        for (const w of v.remaining_work.slice(0, 5)) {
          const priority = w.priority === "critical" ? "!!" : w.priority === "high" ? "! " : "  ";
          lines.push(`  ║   ${priority} ${padRight(w.description.slice(0, W - 16), W - 16)}  ║`);
        }
      }
    }

    lines.push(`  ╚${"═".repeat(Math.min(W - 4, 56))}╝`);
    lines.push("");
    lines.push(`  Commands: /goal-status  /goal-dashboard  /goal-pause  /goal-resume  /goal-repair-capabilities`);
    lines.push("");

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Status bar helper ───────────────────────────────────────────────

export function updateStatusBar(ctx: ExtensionContext, state: IterativeGoalState | null): void {
  if (!ctx.hasUI || !state) {
    ctx.ui.setStatus("iterative-goal", undefined);
    return;
  }

  const progress = calculateProgress(state);
  const evalInfo = state.evaluator.lastVerdict
    ? `${state.evaluator.lastVerdict.goal_met ? "✓" : "✗"} eval:${Math.round(state.evaluator.lastVerdict.confidence * 100)}%`
    : "no eval";

  const text = `🎯 C${state.cycle} ${phaseIcon(state.phase)} ${state.phase} · ${Math.round(progress)}% · ${evalInfo}`;
  ctx.ui.setStatus("iterative-goal", text);
}

export function clearStatusBar(ctx: ExtensionContext): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus("iterative-goal", undefined);
    ctx.ui.setWidget("iterative-goal", undefined);
  }
}

// ── Widget update ───────────────────────────────────────────────────

export function updateWidget(
  ctx: ExtensionContext,
  state: IterativeGoalState | null,
): void {
  if (!ctx.hasUI || !state) {
    ctx.ui.setWidget("iterative-goal", undefined);
    return;
  }

  const lines: string[] = [];
  const s = state;

  lines.push(`🎯 ${s.goal.slice(0, 60)}${s.goal.length > 60 ? "..." : ""}`);
  lines.push(`C${s.cycle} ${phaseIcon(s.phase)} ${s.phase} · ${statusIcon(s.status)} ${s.status}`);

  if (s.evaluator.lastVerdict) {
    const v = s.evaluator.lastVerdict;
    lines.push(`Eval: ${v.goal_met ? "✓ met" : "✗ not met"} (conf: ${Math.round(v.confidence * 100)}%)`);
    if (v.next_cycle_directive.focus) {
      lines.push(`Next: ${v.next_cycle_directive.focus}`);
    }
    for (const b of v.completion_blockers.slice(0, 2)) {
      lines.push(`  ⚠ ${b.slice(0, 50)}`);
    }
  }

  // Latest errors
  const recentUnresolved = state.errors.filter((e) => !e.resolved).slice(-2);
  for (const e of recentUnresolved) {
    lines.push(`  ❌ [${e.phase}] ${e.kind}${e.missingTool ? ":" + e.missingTool : ""}`);
  }

  ctx.ui.setWidget("iterative-goal", lines, { placement: "belowEditor" });
}

// ── Progress calculation ────────────────────────────────────────────

function calculateProgress(state: IterativeGoalState): number {
  // Simple heuristic: each cycle through the 4 phases = 25% per phase
  // plus evaluator adjustments
  const baseProgress = Math.min(95, ((state.cycle - 1) * 100) / (state.cycle + 2));
  if (state.evaluator.lastVerdict?.goal_met) return 100;
  return baseProgress;
}

function padRight(text: string, width: number): string {
  const len = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return text + " ".repeat(Math.max(0, width - len));
}

// ── Command registration ────────────────────────────────────────────

export function registerDashboardCommands(
  pi: ExtensionAPI,
  stateManager: StateManager,
): void {
  pi.registerCommand("goal-dashboard", {
    description: "Show iterative-goal dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/goal-dashboard requires interactive mode", "error");
        return;
      }

      const state = stateManager.getState();
      await ctx.ui.custom<void>((_tui, _theme, _kb, done) => {
        return new DashboardComponent(state, stateManager, () => done());
      });
    },
  });
}