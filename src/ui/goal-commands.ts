import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAwsCliConfig } from "../aws-cli.js";
import { type PhaseIndicatorHandle } from "./phase-indicator.js";
import { loadFinalizationPolicy } from "../git.js";
import { renderPhasePrompt, renderResumePrompt } from "../phases.js";
import { type StateManagerAPI } from "../state.js";
import { type CapabilitySnapshot, type IterativeGoalState, type PhaseArtifact } from "../types.js";
import { detectSubagentBackend } from "../capabilities.js";
import { cancelRunSubagent, shutdownRunAgentPools } from "../agents/run-pool.js";
import {
  loadConfiguredModel,
  preflightAllModels,
  startPhaseAttempt,
} from "../kernel/workflow-engine.js";
import { getChangedFiles, getDiffStat } from "../workspace/change-set.js";
import { loadTrustedVerificationConfig, trustedVerificationConfigHash } from "../trusted-verification.js";

export interface GoalCommandServices {
  buildRuntimeCapabilitySnapshot(
    ctx: ExtensionCommandContext,
    state: IterativeGoalState,
  ): Promise<CapabilitySnapshot>;
  log(message: string): void;
}

export function registerGoalRuntimeCommands(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
  services: GoalCommandServices,
  phaseIndicator: PhaseIndicatorHandle,
): void {
  pi.registerCommand("goal-start", {
    description: "Start an autonomous iterative goal loop",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (!trimmed) { ctx.ui.notify("Usage: /goal-start <goal> [#criterion: <criteria>]", "warning"); return; }

      let goal = trimmed;
      let criterion = "All explicit completion criteria are satisfied, validation passes, and state is reproducible.";
      const cm = trimmed.match(/#criterion:\s*(.+)/);
      if (cm) { criterion = cm[1].trim(); goal = trimmed.replace(cm[0], "").trim(); }

      const existing = stateManager.getState() ?? stateManager.restore(ctx);
      if (existing && existing.status === "running") {
        const ok = await ctx.ui.confirm("Replace active goal?",
          `An iterative goal is already running: "${existing.goal}"\n\nStart a new one? Old queued phases will be cancelled.`);
        if (!ok) return;
        stateManager.cancelQueuedPhases(existing.runId);
        stateManager.releaseLock(existing.runId, existing.lock.activePhaseId ?? "");
      }
      // A replacement run cannot overlap detached workers from any prior
      // state, including paused/blocked runs. Admission resumes only after
      // exact TERM→KILL teardown has settled.
      if (existing) await shutdownRunAgentPools();

      const trustedVerification = loadTrustedVerificationConfig(ctx.cwd);
      const state = stateManager.createRun(
        goal,
        criterion,
        { awsCli: loadAwsCliConfig(ctx.cwd) },
        {
          required: trustedVerification.enabled,
          checksHash: trustedVerification.enabled ? trustedVerificationConfigHash(trustedVerification) : null,
          pinnedAt: new Date().toISOString(),
        },
      );
      refreshFinalizationPolicy(state, ctx.cwd);
      const modelHealth = await preflightAllModels(ctx,
        state.config.primaryModel,
        state.config.fallbackModels,
      );
      state.config.modelHealth = modelHealth;

      services.log(`Goal started: runId=${state.runId}, goal="${goal}"`);

      const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
      stateManager.setCapabilities(snapshot);

      const backends = detectSubagentBackend(pi, snapshot);
      const startResult = await startPhaseAttempt(state, stateManager, "research", snapshot, pi, ctx);
      if (!startResult.started) {
        ctx.ui.notify(`Iterative goal did not start: ${startResult.reason}. No phase prompt was sent.`, "warning");
        services.log(`Goal start stopped before prompt: ${startResult.reason}`);
        return;
      }

      const prompt = renderPhasePrompt("research", state, snapshot, backends);
      pi.sendUserMessage(prompt);
      ctx.ui.notify(`Iterative goal started: cycle ${state.cycle}, phase research`);
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show status (--json for machine output)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      if (!state) {
        ctx.ui.notify(args.includes("--json")
          ? JSON.stringify({ active: false }, null, 2) : "No active iterative goal. Start with /goal-start.", "info");
        return;
      }

      if (args.includes("--json")) {
        ctx.ui.notify(JSON.stringify(renderStatusJson(state, stateManager), null, 2), "info");
        return;
      }

      ctx.ui.notify(renderStatusText(state).join("\n"), "info");
    },
  });

  pi.registerCommand("goal-pause", {
    description: "Pause the loop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state || state.status !== "running") { ctx.ui.notify("No active goal to pause.", "warning"); return; }
      stateManager.setStatus("paused_by_user");
      ctx.ui.notify(`Goal paused at cycle ${state.cycle}. Use /goal-resume.`, "info");
      services.log("Paused by user");
    },
  });

  pi.registerCommand("goal-resume", {
    description: "Resume paused loop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state || state.status !== "paused_by_user") { ctx.ui.notify("No paused goal.", "warning"); return; }
      stateManager.setStatus("running");

      const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);
      const startResult = await startPhaseAttempt(state, stateManager, state.phase, snapshot, pi, ctx);
      if (!startResult.started) {
        ctx.ui.notify(`Goal resume stopped before prompting: ${startResult.reason}.`, "warning");
        services.log(`Goal resume stopped before prompt: ${startResult.reason}`);
        return;
      }
      const prompt = renderResumePrompt(state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify(`Resuming: cycle ${state.cycle}, phase ${state.phase}`, "info");
      services.log("Resumed");
    },
  });

  pi.registerCommand("goal-approve", {
    description: "Approve a pending cyber approval token",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const token = args.trim();
      if (!token) { ctx.ui.notify("Usage: /goal-approve <token>", "warning"); return; }
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const resolved = stateManager.resolveApproval(token, "approved");
      if (!resolved) { ctx.ui.notify(`No pending approval found for token: ${token}`, "warning"); return; }
      if (resolved.status !== "approved") {
        ctx.ui.notify(`Approval token expired before it could be approved: ${token}`, "warning");
        services.log(`Approval expired: ${token}`);
        return;
      }
      const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
      stateManager.setCapabilities(snapshot);
      const backends = detectSubagentBackend(pi, snapshot);
      // Approval resumes the exact paused phase attempt to which the token was
      // bound. Starting a fresh attempt here would either widen the approval
      // across attempts or make an exact capability unusable.
      const prompt = renderResumePrompt(state, snapshot, backends);
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify(`Approval accepted for: ${resolved.requestedAction}`, "info");
      services.log(`Approval accepted: ${token}`);
    },
  });

  pi.registerCommand("goal-deny", {
    description: "Deny a pending cyber approval token",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const token = args.trim();
      if (!token) { ctx.ui.notify("Usage: /goal-deny <token>", "warning"); return; }
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const resolved = stateManager.resolveApproval(token, "denied");
      if (!resolved) { ctx.ui.notify(`No pending approval found for token: ${token}`, "warning"); return; }
      stateManager.recordError({
        timestamp: new Date().toISOString(),
        phase: state.phase,
        cycle: state.cycle,
        kind: "approval_denied",
        rawText: `Approval denied for ${resolved.requestedAction}`,
        recoveryAction: "Record policy_denied and replan without the denied action.",
        resolved: false,
      });
      ctx.ui.notify(`Approval denied for: ${resolved.requestedAction}`, "warning");
      services.log(`Approval denied: ${token}`);
    },
  });

  pi.registerCommand("goal-swarm-cancel", {
    description: "Cancel an in-flight subagent task; its write scope releases only after process close",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const taskId = args.trim();
      if (!taskId) { ctx.ui.notify("Usage: /goal-swarm-cancel <taskId>", "warning"); return; }
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const status = await cancelRunSubagent(state.runId, taskId);
      if (status === "running") {
        ctx.ui.notify(`Subagent task ${taskId} was running; SIGTERM sent, with exact SIGKILL escalation if needed. Its write scope stays held until process close.`, "info");
      } else if (status === "queued") {
        ctx.ui.notify(`Subagent task ${taskId} was queued; it will never be executed (cancelled before admission).`, "info");
      } else if (status === "unknown") {
        ctx.ui.notify(`No in-flight subagent task found with id: ${taskId}`, "warning");
      } else {
        ctx.ui.notify(`No swarm pool found for this run (task ${taskId} not cancelled).`, "warning");
      }
      services.log(`Swarm cancel requested: task=${taskId}, status=${status ?? "no-pool"}`);
    },
  });

  pi.registerCommand("goal-repair-capabilities", {
    description: "Run capability preflight and fix",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const snapshot = await services.buildRuntimeCapabilitySnapshot(ctx, state);
      stateManager.setCapabilities(snapshot);
      const issues: string[] = [];
      if (!snapshot.hasBashTool) issues.push("bash unavailable (goal_shell available)");
      if (!snapshot.hasSubagentTool && !snapshot.hasAgentTool) issues.push("no subagent backend");
      if (snapshot.awsCli?.enabled) {
        issues.push(...snapshot.awsCli.issues.map((issue) => `aws: ${issue}`));
      }
      ctx.ui.notify(issues.length === 0 ? "Capabilities good." : `Issues:\n${issues.map(i => `  - ${i}`).join("\n")}`, issues.length === 0 ? "info" : "warning");

      state.config.modelHealth = await preflightAllModels(
        ctx,
        state.config.primaryModel,
        state.config.fallbackModels,
      );
      stateManager.persistAll();

      if (state.status === "provider_unavailable") {
        stateManager.setStatus("running");
        const backends = detectSubagentBackend(pi, snapshot);
        const startResult = await startPhaseAttempt(state, stateManager, state.phase, snapshot, pi, ctx);
        if (!startResult.started) {
          ctx.ui.notify(`Provider repair did not recover a loadable exact model: ${startResult.reason}.`, "warning");
          return;
        }
        pi.sendUserMessage(renderResumePrompt(state, snapshot, backends), { deliverAs: "followUp" });
        ctx.ui.notify(`Provider repair loaded ${startResult.model.provider}/${startResult.model.model}; resuming.`, "info");
        return;
      }

      for (const candidate of [state.config.primaryModel, ...state.config.fallbackModels]) {
        const health = state.config.modelHealth[`${candidate.provider}/${candidate.model}`];
        if (health?.lastStatus !== "available") continue;
        const loaded = await loadConfiguredModel(ctx, pi, candidate.provider, candidate.model);
        if (loaded.loaded) {
          ctx.ui.notify(`Verified exact model: ${loaded.route.piSelection}`, "info");
          return;
        }
      }
      ctx.ui.notify("No configured exact model passed capability repair.", "warning");
    },
  });

  pi.registerCommand("goal-finalize", {
    description: "Finalize: generate patch. --mode patch (default).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }

      if (!state.finalizationPolicy.allowGitFinalization && !state.finalizationPolicy.allowCommit) {
        await writePatchAndDescription(state, stateManager, ctx);
        return;
      }

      const modeMatch = args.match(/--mode\s+(\w+)/);
      const mode = modeMatch?.[1] ?? "patch";
      if (mode === "patch") {
        await writePatchOnly(state, stateManager, ctx);
        return;
      }
      if (mode === "commit" && state.finalizationPolicy.allowCommit) {
        ctx.ui.notify("Git finalization enabled by policy. Use goal_git for staged commit/push/PR actions.", "info");
        return;
      }
      ctx.ui.notify("Requested finalization mode is not allowed by policy.", "warning");
    },
  });

  pi.registerCommand("goal-reset", {
    description: "Reset state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = stateManager.getState();
      if (!state) { ctx.ui.notify("No active goal.", "info"); return; }
      const ok = await ctx.ui.confirm("Reset?", `Clear goal "${state.goal}" and all artifacts?`);
      if (!ok) return;

      archiveActiveRun();
      stateManager.clear();
      // Run boundary: tear down the run's pool and its cross-call
      // write-scope registry with the run (C1-ADV-003).
      await shutdownRunAgentPools();
      phaseIndicator.clearSurfaces(ctx);
      ctx.ui.notify("Iterative goal reset.", "info");
      services.log("Reset by user");
    },
  });
}

function refreshFinalizationPolicy(
  state: IterativeGoalState,
  cwd: string,
): void {
  state.finalizationPolicy = loadFinalizationPolicy(cwd);
  state.constraints.allowGitFinalization = state.finalizationPolicy.allowGitFinalization;
}

function getLastArtifactForPhase(
  state: IterativeGoalState,
  phase: IterativeGoalState["phase"],
): PhaseArtifact | null {
  switch (phase) {
    case "research": return state.artifacts.research.at(-1) ?? null;
    case "plan": return state.artifacts.plans.at(-1) ?? null;
    case "implement": return state.artifacts.implementations.at(-1) ?? null;
    case "validate": return state.artifacts.validations.at(-1) ?? null;
  }
}

function getLastArtifactForPhaseCycle(
  state: IterativeGoalState,
  phase: IterativeGoalState["phase"],
  cycle: number,
): PhaseArtifact | null {
  const artifact = getLastArtifactForPhase(state, phase);
  return artifact?.cycle === cycle ? artifact : null;
}

function renderStatusJson(state: IterativeGoalState, stateManager: StateManagerAPI): Record<string, unknown> {
  const es = state.evaluatorState;
  const latestArtifact = getLastArtifactForPhaseCycle(state, state.phase, state.cycle);
  return {
    active: true, runId: state.runId, goal: state.goal, goalCriterion: state.goalCriterion,
    status: state.status, cycle: state.cycle, phase: state.phase,
    swarm: renderSwarmSummary(state.swarm),
    lock: {
      activeRunId: state.lock.activeRunId, activePhaseId: state.lock.activePhaseId,
      phaseStatus: state.lock.phaseStatus, phaseStartedAt: state.lock.phaseStartedAt,
      queuedPhaseIds: state.lock.queuedPhaseIds,
    },
    evaluator: {
      model: `${state.evaluator.provider}/${state.evaluator.model}`,
      status: es?.status ?? "not_started",
      startedAt: es?.startedAt ?? null,
      lastHeartbeatAt: es?.lastHeartbeatAt ?? null,
      isStale: es?.lastHeartbeatAt ? (Date.now() - new Date(es.lastHeartbeatAt).getTime() > 120_000) : null,
      error: es?.error ?? null,
      lastVerdict: state.evaluator.lastVerdict ? {
        goal_met: state.evaluator.lastVerdict.goal_met,
        confidence: state.evaluator.lastVerdict.confidence,
        blockers: state.evaluator.lastVerdict.completion_blockers,
        next_focus: state.evaluator.lastVerdict.next_cycle_directive.focus,
      } : null,
    },
    artifacts: {
      research: state.artifacts.research.length, plans: state.artifacts.plans.length,
      implementations: state.artifacts.implementations.length, validations: state.artifacts.validations.length,
      evaluatorReports: state.artifacts.evaluatorReports.length,
    },
    projectInstructions: {
      discoveredAt: state.projectInstructions.discoveredAt,
      repoRoot: state.projectInstructions.repoRoot,
      cwd: state.projectInstructions.cwd,
      files: state.projectInstructions.files.map(file => ({
        path: file.path,
        filename: file.filename,
        sha256: file.sha256,
        bytes: file.bytes,
        truncated: file.truncated,
        precedence: file.precedence,
      })),
    },
    taskPlan: state.taskPlan,
    errors: state.errors.length,
    unresolvedErrors: state.errors.filter(e => !e.resolved).map(e => ({
      phase: e.phase, kind: e.kind, cycle: e.cycle, recoveryAction: e.recoveryAction,
    })),
    modelHealth: state.config.modelHealth,
    awsCli: state.config.awsCli,
    finalizationPolicy: state.finalizationPolicy,
    cyber: {
      dlp: state.dlp,
      sanitizer: state.sanitizer,
      sandbox: state.sandbox,
      signing: {
        required: state.signing.required,
        algorithm: state.signing.algorithm,
        keyId: state.signing.keyId,
        available: state.signing.available,
        runPublicKey: state.signing.runPublicKey,
      },
      attestations: state.attestations.length,
      pendingApprovals: state.approvals.pending,
      approvalHistory: state.approvals.history.slice(-10),
      unifyCasProfile: state.unifyCasProfile,
    },
    releaseAuthorization: state.releaseAuthorization ? {
      id: state.releaseAuthorization.id,
      headSha: state.releaseAuthorization.headSha,
      expiresAt: state.releaseAuthorization.expiresAt,
      allowedAction: state.releaseAuthorization.allowedAction,
    } : null,
    phaseAttempts: state.phaseAttempts.slice(-5).map(a => ({
      phaseAttemptId: a.phaseAttemptId, cycle: a.cycle, phase: a.phase,
      attempt: a.attempt, status: a.status,
      model: `${a.modelProvider}/${a.modelModel}`, fallbackChain: a.fallbackChain,
    })),
    lastTransitionEvent: state.phaseAttempts.length > 0 ? {
      kind: state.phaseAttempts.at(-1)!.status,
      timestamp: state.phaseAttempts.at(-1)!.startedAt,
    } : null,
    latestArtifact: latestArtifact ? {
      phase: latestArtifact.phase,
      status: latestArtifact.status,
      source: latestArtifact.synthesis?.source ?? "unknown",
      nonceMatched: latestArtifact.synthesis?.nonceMatched ?? false,
      reason: latestArtifact.synthesis?.reason ?? null,
    } : null,
    artifactPaths: {
      research: state.artifacts.research.length > 0 ? stateManager.getArtifactPath(state.cycle, "research", "result.json") : null,
      plan: state.artifacts.plans.length > 0 ? stateManager.getArtifactPath(state.cycle, "plan", "result.json") : null,
      implement: state.artifacts.implementations.length > 0 ? stateManager.getArtifactPath(state.cycle, "implement", "result.json") : null,
      validate: state.artifacts.validations.length > 0 ? stateManager.getArtifactPath(state.cycle, "validate", "result.json") : null,
    },
  };
}

function renderSwarmSummary(swarm: IterativeGoalState["swarm"]): Record<string, unknown> {
  const tasks = swarm?.tasks ?? [];
  // failed folds cancelled — consistent with the phase-indicator swarm line;
  // cancelled is reported separately here as a per-status detail (C1-ADV-017).
  return {
    backend: swarm?.backend ?? null,
    total: tasks.length,
    running: tasks.filter((task) => task.status === "running").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  };
}

function renderStatusText(state: IterativeGoalState): string[] {
  const lines = [
    `Iterative Goal Status:`,
    `  Run ID: ${state.runId}`, `  Goal: ${state.goal}`, `  Criterion: ${state.goalCriterion}`,
    `  Status: ${state.status}`, `  Cycle: ${state.cycle}`, `  Phase: ${state.phase}`,
    `  Lock: ${state.lock.phaseStatus} (owner: ${state.lock.activePhaseId || "none"})`,
    `  Artifacts: R:${state.artifacts.research.length} P:${state.artifacts.plans.length} I:${state.artifacts.implementations.length} V:${state.artifacts.validations.length}`,
    `  Project instructions: ${state.projectInstructions.files.length} files`,
    `  Task plan: ${state.taskPlan.items.length} items, in_progress=${state.taskPlan.items.find(item => item.status === "in_progress")?.id ?? "none"}`,
    `  Errors: ${state.errors.length}`,
    `  DLP redactions: ${state.dlp.redactionCount}`,
    `  IPI detections: ${state.sanitizer.ipiDetections}`,
    `  Evidence signer: ${state.signing.available ? "available" : "unavailable"} (${state.signing.keyId})`,
    `  Attestations: ${state.attestations.length}`,
    `  Pending approvals: ${state.approvals.pending.length}`,
  ];
  const swarmSummary = renderSwarmSummary(state.swarm);
  if ((swarmSummary.total as number) > 0) {
    lines.push(
      `  Swarm: ${swarmSummary.completed}/${swarmSummary.total} done · ${swarmSummary.running} running · ${swarmSummary.failed} failed` +
      (state.swarm.backend ? ` · backend ${state.swarm.backend}` : ""),
    );
  }
  if (state.config.awsCli.enabled) {
    lines.push(
      `  AWS: profile=${state.config.awsCli.preflight?.resolvedProfile ?? "unresolved"} region=${state.config.awsCli.preflight?.resolvedRegion ?? state.config.awsCli.defaultRegion}`,
      `  AWS Issues: ${state.config.awsCli.preflight?.issues.length ?? 0}`,
    );
  }
  if (state.evaluatorState) {
    lines.push("", `  Evaluator: ${state.evaluatorState.status}`,
      `  Started: ${state.evaluatorState.startedAt ?? "never"}`, `  Heartbeat: ${state.evaluatorState.lastHeartbeatAt ?? "never"}`,
      state.evaluatorState.error ? `  Error: ${state.evaluatorState.error}` : "");
  }
  if (state.evaluator.lastVerdict) {
    const v = state.evaluator.lastVerdict;
    lines.push("", `  Last Verdict: goal_met=${v.goal_met}, confidence=${v.confidence}`,
      `  Blockers: ${v.completion_blockers.length}`, `  Next focus: ${v.next_cycle_directive.focus}`);
  }
  return lines;
}

async function writePatchAndDescription(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const patchPath = stateManager.getArtifactPath(state.cycle, state.phase, "final.patch");
  try {
    const { execSync } = await import("node:child_process");
    const patch = execSync("git diff", { encoding: "utf-8", timeout: 10_000 });
    fs.writeFileSync(patchPath, patch);

    const prDescPath = stateManager.getArtifactPath(state.cycle, state.phase, "pr-description.md");
    const prDesc = [
      `# ${state.goal}`, "",
      `**Run ID**: ${state.runId}`, `**Cycles**: ${state.cycle}`,
      state.evaluator.lastVerdict ? `**Verdict**: goal_met=${state.evaluator.lastVerdict.goal_met} confidence=${state.evaluator.lastVerdict.confidence}` : "**Verdict**: not yet evaluated",
      "", "## Changed Files",
      ...(await getChangedFiles()).map(f => `- ${f}`),
      "", "## Diff Stat", "",
      await getDiffStat(), "",
      "## Safety Notes",
      state.evaluator.lastVerdict?.safety_notes.map(n => `- ${n}`).join("\n") || "- None",
      "",
      `Patch: \`${patchPath}\``,
    ].join("\n");
    fs.writeFileSync(prDescPath, prDesc);

    ctx.ui.notify(`Patch: ${patchPath}\nPR description: ${prDescPath}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`Failed: ${err.message}`, "error");
  }
}

async function writePatchOnly(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const patchPath = stateManager.getArtifactPath(state.cycle, state.phase, "final.patch");
  try {
    const { execSync } = await import("node:child_process");
    fs.writeFileSync(patchPath, execSync("git diff", { encoding: "utf-8", timeout: 10_000 }));
    ctx.ui.notify(`Patch: ${patchPath}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`Failed: ${err.message}`, "error");
  }
}

function archiveActiveRun(): void {
  try {
    const activePath = path.join(process.cwd(), ".pi", "iterative-goal", "active-run.json");
    if (fs.existsSync(activePath)) {
      const legacyDir = path.join(process.cwd(), ".pi", "iterative-goal", "legacy");
      fs.mkdirSync(legacyDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(activePath, path.join(legacyDir, `active-run-${ts}.json`));
    }
  } catch {}
}
