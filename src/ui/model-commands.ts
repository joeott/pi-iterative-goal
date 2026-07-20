import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODEL_ROSTER } from "../domain/model-roster.js";
import { getManagedLogHealth, runManagedLogRetention } from "../log-retention.js";
import { compareModelInvocations, loadModelInvocations, writeModelComparisonReport } from "../model-telemetry.js";
import type { StateManagerAPI } from "../state.js";

export function registerModelObservabilityCommands(pi: ExtensionAPI, stateManager: StateManagerAPI): void {
  pi.registerCommand("goal-models", {
    description: "Show the frozen exact-only model roster (--json for machine output)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      const payload = {
        schemaVersion: MODEL_ROSTER.schemaVersion,
        catalogDate: MODEL_ROSTER.catalogDate,
        catalogHash: MODEL_ROSTER.catalogHash,
        frozenForRun: state?.runId ?? null,
        profiles: MODEL_ROSTER.profiles.map((profile) => ({
          routeId: profile.id,
          provider: profile.provider,
          model: profile.model,
          familyId: profile.familyId,
          reasoning: profile.reasoning,
          serving: profile.serving,
          capabilities: profile.capabilities,
          credentialEnv: profile.credential.primaryEnv,
        })),
        routing: MODEL_ROSTER.routing,
      };
      if (args.includes("--json")) {
        ctx.ui.notify(JSON.stringify(payload, null, 2), "info");
        return;
      }
      ctx.ui.notify([
        `Exact model roster ${payload.catalogHash.slice(0, 12)} (${payload.profiles.length} profiles)`,
        ...payload.profiles.map((profile) => `- ${profile.routeId}: ${profile.provider}/${profile.model} [${profile.reasoning.variant}; ${profile.serving.variant}]`),
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("goal-telemetry-status", {
    description: "Show local metadata-only model telemetry and comparison readiness",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      const runId = state?.runId;
      const invocations = loadModelInvocations(ctx.cwd, runId);
      const comparisons = compareModelInvocations(invocations);
      const reportPath = writeModelComparisonReport(ctx.cwd, runId);
      const payload = {
        runId: runId ?? null,
        invocationCount: invocations.length,
        sufficientComparisons: comparisons.filter((item) => item.sufficientData).length,
        insufficientComparisons: comparisons.filter((item) => !item.sufficientData).length,
        comparisonReport: reportPath,
        retention: getManagedLogHealth(),
      };
      ctx.ui.notify(args.includes("--json")
        ? JSON.stringify(payload, null, 2)
        : [
          `Model telemetry: ${payload.invocationCount} invocation(s) for ${payload.runId ?? "all runs"}`,
          `Comparable groups: ${payload.sufficientComparisons} ready, ${payload.insufficientComparisons} insufficient_data`,
          `Comparison report: ${payload.comparisonReport}`,
          `Retention: ${payload.retention?.blocked ? `BLOCKED (${payload.retention.reasons.join("; ")})` : "healthy"}`,
        ].join("\n"), "info");
    },
  });

  pi.registerCommand("goal-log-purge", {
    description: "Run the ownership-scoped managed-log retention pass",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const report = runManagedLogRetention(ctx.cwd);
      ctx.ui.notify(JSON.stringify(report, null, 2), report.blocked ? "warning" : "info");
    },
  });
}
