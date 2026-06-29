/**
 * iterative-goal - Autonomous supervisor loop for Pi Coding Agent.
 *
 * Architecture:
 *   The extension owns a durable four-phase loop (research → plan →
 *   implement → validate/evaluate). It never voluntarily stops until
 *   an external evaluator returns goal_met: true.
 *
 * Key invariants (harness v3 — hardened):
 *   1. No stale queued phase may mutate a different run.
 *   2. No phase result is accepted unless runId + phaseAttemptId match the active lock.
 *   3. Synthesized artifacts are only recorded for the active phase attempt.
 *   4. Only the evaluator may declare goal completion.
 *   5. Every phase transition is backed by durable, run-scoped artifacts.
 *   6. Every file path written includes runId + cycle + phase.
 *   7. Old v1 state is migrated or rejected safely.
 *   8. Git finalization default-deny; produces patch without attempting git ops.
 *   9. /goal-status --json is authoritative for "is eval running?"
 *   10. Build + smoke pass before reporting completion.
 */

import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createStateManager,
} from "./state.js";
import { takeCapabilitySnapshot } from "./capabilities.js";
import { classifyError, getRecoveryAction } from "./errors.js";
import { registerGoalShellTool } from "./shell.js";
import { registerGoalRepoContextTool } from "./repo-context.js";
import { registerGoalSubagentTool } from "./subagents.js";
import {
  generateValidationScript,
} from "./phases.js";
import { registerDashboardCommands } from "./dashboard.js";
import {
  loadAwsCliConfig,
  preflightAwsCli,
  registerGoalAwsCliTool,
  withAwsCliPreflight,
} from "./aws-cli.js";
import {
  getGitCapability,
  loadFinalizationPolicy,
  registerGoalGitTool,
} from "./git.js";
import {
  type PhaseLifecycleEvent,
  type IterativeGoalState,
  type CapabilitySnapshot,
} from "./types.js";
import { registerGoalLifecycle } from "./kernel/lifecycle.js";
import { registerGovernanceCommands } from "./ui/commands.js";
import { registerGoalRuntimeCommands } from "./ui/goal-commands.js";
import { registerGoalCoreTools } from "./ui/tools.js";
import { registerToolInterception } from "./ui/tool-interception.js";
import { logDebug } from "./logging.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { registerHarnessUi } from "./harness-ui.js";
import { registerZaiGlm52Provider, registerZaiGlm52ProviderWithPi } from "./zai.js";

export { extractTextFromParts, synthesizePhaseResultSafe } from "./kernel/output-synthesis.js";

function log(msg: string) {
  logDebug("core", msg);
}

function refreshAwsCliConfig(
  state: IterativeGoalState,
  cwd: string,
): void {
  const currentPreflight = state.config.awsCli?.preflight ?? null;
  state.config.awsCli = {
    ...loadAwsCliConfig(cwd),
    preflight: currentPreflight,
  };
}

function refreshFinalizationPolicy(
  state: IterativeGoalState,
  cwd: string,
): void {
  state.finalizationPolicy = loadFinalizationPolicy(cwd);
  state.constraints.allowGitFinalization = state.finalizationPolicy.allowGitFinalization;
}

async function buildRuntimeCapabilitySnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  state?: IterativeGoalState | null,
): Promise<CapabilitySnapshot> {
  registerZaiGlm52Provider(ctx);
  const snapshot = takeCapabilitySnapshot(pi);
  if (!state) return snapshot;

  refreshAwsCliConfig(state, ctx.cwd);
  refreshFinalizationPolicy(state, ctx.cwd);
  state.projectInstructions = loadProjectInstructions(ctx.cwd);
  if (!state.config.awsCli.enabled) {
    snapshot.awsCli = null;
  } else {
    const preflight = await preflightAwsCli(pi, ctx, state.config.awsCli);
    state.config.awsCli = withAwsCliPreflight(state.config.awsCli, preflight);
    snapshot.awsCli = preflight;
  }
  snapshot.gitFinalization = await getGitCapability(pi, ctx, state.finalizationPolicy);
  snapshot.hasAws = state.config.awsCli.enabled;
  snapshot.hasAwsConfig = state.config.awsCli.enabled;
  snapshot.hasSandbox = state.sandbox.enabled;
  snapshot.hasDlpProxy = state.dlp.enabled && state.dlp.scannerAvailable;
  snapshot.hasIpiSanitizer = state.sanitizer.enabled && state.sanitizer.sanitizerAvailable;
  snapshot.hasEvidenceSigner = state.signing.available;
  snapshot.unavailableCapabilities = [
    !snapshot.hasDlpProxy ? "dlp_pre_context_scrub" : "",
    !snapshot.hasIpiSanitizer ? "ipi_untrusted_data_delimiters" : "",
    !snapshot.hasEvidenceSigner ? "ed25519_evidence_attestation" : "",
    !snapshot.hasSandbox ? "sandbox_profile" : "",
  ].filter(Boolean);
  return snapshot;
}

// ── Main Extension ──────────────────────────────────────────────────

export default function registerIterativeGoalExtension(pi: ExtensionAPI): void {
  log("=== Extension initializing (v3 hardened) ===");
  registerZaiGlm52ProviderWithPi(pi);
  const stateManager = createStateManager(pi);

  // ── Register tools ───────────────────────────────────────────────

  registerGoalShellTool(
    pi,
    () => stateManager.getState()?.config.awsCli ?? null,
    () => stateManager.getState()?.finalizationPolicy ?? null,
    stateManager,
  );
  registerGoalAwsCliTool(pi, stateManager);
  registerGoalGitTool(pi, stateManager);
  registerGoalRepoContextTool(pi, stateManager);
  registerGoalSubagentTool(pi, () => stateManager.getState()?.capabilities ?? null);
  registerGoalCoreTools(pi, stateManager, { log });

  registerGoalLifecycle(pi, stateManager, {
    buildRuntimeCapabilitySnapshot: (ctx, state) => buildRuntimeCapabilitySnapshot(pi, ctx, state),
    log,
  });

  registerToolInterception(pi, stateManager, { log });

  registerGoalRuntimeCommands(pi, stateManager, {
    buildRuntimeCapabilitySnapshot: (ctx, state) => buildRuntimeCapabilitySnapshot(pi, ctx, state),
    log,
  });

  registerGovernanceCommands(pi, stateManager);

  registerDashboardCommands(pi, stateManager);

  registerHarnessUi(pi, stateManager);
}
