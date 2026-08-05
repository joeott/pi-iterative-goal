/**
 * Dashboard UI - TUI display for iterative-goal status.
 *
 * Shows cycle, phase, blockers, evaluator verdict, error history,
 * and active recommendations. Mirrors the pi-autoresearch dashboard.
 *
 * All goal/phase chrome content (status bar, widget, header goal line)
 * is owned by src/ui/phase-indicator.ts; this file keeps only the modal
 * /goal-dashboard component, which re-reads state inside invalidate()
 * so the 1 Hz ticker can refresh it while open.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, Box, Spacer } from "@earendil-works/pi-tui";
import type { IterativeGoalState } from "./types.js";
import { type StateManagerAPI } from "./state.js";
import {
  type PhaseIndicatorHandle,
  phaseIcon,
  renderModel,
  statusIcon,
} from "./ui/phase-indicator.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Dashboard component ─────────────────────────────────────────────

export class DashboardComponent {
  private state: IterativeGoalState | null;
  private stateManager: StateManagerAPI;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(state: IterativeGoalState | null, stateManager: StateManagerAPI, onClose: () => void) {
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
      : s.evaluatorState
        ? `Evaluator: ${s.evaluatorState.status}`
        : `Evaluator: not started`;
    lines.push(`  ║ ${padRight(evalInfo, W - 8)}  ║`);

    // Live fields from the shared render model: per-phase elapsed,
    // evaluator heartbeat age, and real cycle progress (G2, G3, G5).
    const model = renderModel(s);
    lines.push(`  ║ ${padRight(`Phase elapsed: ${model.elapsed} · Progress: ${model.progressPct}%`, W - 8)}  ║`);
    if (model.evaluator && model.evaluator.heartbeatAgeS !== null) {
      lines.push(`  ║ ${padRight(`Evaluator heartbeat: ${model.evaluator.heartbeatAgeS}s ago`, W - 8)}  ║`);
    }

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
    // Re-read live state so the ticker can refresh an open modal.
    this.state = this.stateManager.getState();
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function padRight(text: string, width: number): string {
  const len = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return text + " ".repeat(Math.max(0, width - len));
}

// ── Command registration ────────────────────────────────────────────

export function registerDashboardCommands(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
  phaseIndicator: PhaseIndicatorHandle,
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
        const component = new DashboardComponent(state, stateManager, () => {
          phaseIndicator.trackDashboard(null);
          done();
        });
        // Ticker invokes invalidate() on version-changed ticks while open.
        phaseIndicator.trackDashboard(component);
        return component;
      });
    },
  });
}
