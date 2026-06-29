import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { StateManagerAPI } from "../state.js";
import { createReleaseAuthorization, hashJson } from "../release/controller.js";
import { runLocalReleaseGate } from "../review/gates/release-gate.js";

export function registerGovernanceCommands(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
): void {
  pi.registerCommand("goal-authorize-release", {
    description: "Run the local pre-PR release authorization gate for the current HEAD",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }

      const verdict = state.evaluator.lastVerdict;
      if (!verdict || verdict.goal_met !== true) {
        ctx.ui.notify("Release authorization denied: evaluator has not accepted the current evidence.", "warning");
        return;
      }

      const unresolved = state.errors.filter((err) => !err.resolved);
      if (unresolved.length > 0) {
        ctx.ui.notify(`Release authorization denied: ${unresolved.length} unresolved harness errors remain.`, "warning");
        return;
      }

      const releaseGate = await runLocalReleaseGate(state, stateManager);
      if (!releaseGate.ok) {
        ctx.ui.notify(`Release authorization denied:\n${releaseGate.reasons.map((reason) => `- ${reason}`).join("\n")}`, "warning");
        return;
      }

      try {
        const auth = await createReleaseAuthorization({
          pi,
          ctx,
          runId: state.runId,
          planHash: hashJson(state.artifacts.plans.at(-1) ?? null),
          requirementsHash: hashJson({ goal: state.goal, criterion: state.goalCriterion }),
          gateVerdictHash: hashJson({ evaluator: verdict, localReleaseGate: releaseGate }),
          evidenceRootHash: hashJson(state.artifacts),
        });
        stateManager.setReleaseAuthorization(auth);
        ctx.ui.notify(`Release authorized for HEAD ${auth.headSha.slice(0, 12)}. Authorization: ${auth.id}`, "info");
      } catch (err) {
        ctx.ui.notify(`Release authorization failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("goal-audit", {
    description: "Show audit pointers for the active iterative-goal run",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const replayed = stateManager.replayActiveState();
      const lines = [
        `Run ID: ${state.runId}`,
        `Status: ${state.status}`,
        `Cycle/phase: ${state.cycle}/${state.phase}`,
        `Events: ${stateManager.getEventsPath()}`,
        `Replay: ${replayed ? "ok" : "unavailable"}`,
        `Artifacts: ${stateManager.getRunDir()}`,
        `ReleaseAuthorization: ${state.releaseAuthorization?.id ?? "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), replayed ? "info" : "warning");
    },
  });

  pi.registerCommand("goal-replay", {
    description: "Replay the active run event log and compare core state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const replayed = stateManager.replayActiveState();
      if (!replayed) {
        ctx.ui.notify(`Replay unavailable for ${stateManager.getEventsPath()}. Legacy runs may lack run_created.initialState.`, "warning");
        return;
      }
      const comparison = {
        runId: replayed.runId === state.runId,
        status: replayed.status === state.status,
        cycle: replayed.cycle === state.cycle,
        phase: replayed.phase === state.phase,
        errors: replayed.errors.length === state.errors.length,
        attempts: replayed.phaseAttempts.length === state.phaseAttempts.length,
      };
      ctx.ui.notify(JSON.stringify({ replayed: true, comparison }, null, 2), Object.values(comparison).every(Boolean) ? "info" : "warning");
    },
  });

  pi.registerCommand("goal-trace", {
    description: "Trace requirement or evidence text in run artifacts: /goal-trace <term>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      const term = args.trim();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      if (!term) { ctx.ui.notify("Usage: /goal-trace <requirement-id-or-term>", "warning"); return; }
      const matches: string[] = [];
      for (const [label, artifacts] of Object.entries({
        research: state.artifacts.research,
        plans: state.artifacts.plans,
        implementations: state.artifacts.implementations,
        validations: state.artifacts.validations,
      })) {
        for (const artifact of artifacts) {
          if (artifact.content.includes(term)) {
            matches.push(`${label} cycle=${artifact.cycle} status=${artifact.status}`);
          }
        }
      }
      ctx.ui.notify(matches.length > 0 ? matches.join("\n") : `No artifact trace found for: ${term}`, matches.length > 0 ? "info" : "warning");
    },
  });
}
