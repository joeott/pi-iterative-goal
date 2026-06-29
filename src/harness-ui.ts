import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectSubagentBackend, takeCapabilitySnapshot } from "./capabilities.js";
import type { StateManagerAPI } from "./state.js";
import type { IterativeGoalState, SubagentBackend } from "./types.js";
import {
  probeZaiGlm52,
  registerZaiGlm52Provider,
  ZAI_GLM_5_2_MODEL,
  ZAI_PROVIDER,
} from "./zai.js";

const HARNESS_STATUS_KEY = "iterative-goal-harness";
const HARNESS_WIDGET_KEY = "iterative-goal-startup";
const DEFAULT_REVIEW_HANDOFF = "/Users/joe/Downloads/third-party-prod-security-review-handoff-2026-06-29.md";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type HarnessMode = "coding" | "security-audit";

interface ModelStartupStatus {
  selected: boolean;
  ok: boolean;
  message: string;
}

interface HarnessUiState {
  mode: HarnessMode;
  model: ModelStartupStatus;
  envFiles: Array<{ path: string; loadedKeys: string[] }>;
  lastUpdatedAt: string;
}

interface SecurityReviewSummary {
  runId?: string;
  mode?: string;
  readOnlyEnforced?: boolean;
  productionMutationsAttempted?: boolean;
  secretValuesRead?: boolean;
  findingSummary?: { open?: number; new?: number; repeated?: number; resolved?: number };
  iterations?: Array<{ commands?: Array<{ status?: string }> }>;
  finishedAt?: string | null;
}

export function registerHarnessUi(pi: ExtensionAPI, stateManager: StateManagerAPI): void {
  let uiState: HarnessUiState = {
    mode: initialMode(),
    model: { selected: false, ok: false, message: "pending" },
    envFiles: [],
    lastUpdatedAt: new Date().toISOString(),
  };

  pi.on("session_start", async (_event, ctx) => {
    uiState.envFiles = registerZaiGlm52Provider(ctx);
    uiState.model = await selectDefaultModel(pi, ctx);
    uiState.lastUpdatedAt = new Date().toISOString();
    renderStartupUi(pi, ctx, stateManager, uiState);
  });

  pi.on("model_select", async (_event, ctx) => {
    uiState.model = modelStatusFromContext(ctx);
    uiState.lastUpdatedAt = new Date().toISOString();
    renderStartupUi(pi, ctx, stateManager, uiState);
  });

  pi.registerCommand("harness-dashboard", {
    description: "Show pi-iterative-goal harness dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/harness-dashboard requires interactive mode", "error");
        return;
      }
      const state = stateManager.getState() ?? stateManager.restore(ctx);
      const snapshot = takeCapabilitySnapshot(pi);
      const backend = detectSubagentBackend(pi, snapshot);
      const review = loadLatestReview();
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new HarnessDashboard(uiState, state, backend, review, theme, () => done());
      });
    },
  });

  pi.registerCommand("harness-doctor", {
    description: "Show harness load diagnostics (--json, --probe-zai)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const snapshot = takeCapabilitySnapshot(pi);
      const backend = detectSubagentBackend(pi, snapshot);
      const review = loadLatestReview();
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      const doctor: Record<string, unknown> = {
        loaded: true,
        extension: "pi-iterative-goal",
        mode: uiState.mode,
        cwd: ctx.cwd,
        model,
        targetModel: `${ZAI_PROVIDER}/${ZAI_GLM_5_2_MODEL}`,
        autoModel: process.env.PI_ITERATIVE_GOAL_AUTO_MODEL !== "0",
        modelStatus: uiState.model,
        envFiles: uiState.envFiles.map((file) => ({ path: file.path, loadedKeys: file.loadedKeys })),
        commands: snapshot.commands.map((command) => command.name).filter((name) => /^(goal-|harness-|security-review)/.test(name)).sort(),
        subagent: backendLabel(backend),
        tools: snapshot.allTools.map((tool) => tool.name).filter((name) => /^goal_/.test(name)).sort(),
        securityReview: review ? summarizeReview(review) : null,
        secretsPrinted: false,
      };
      if (args.includes("--probe-zai")) {
        const probe = await probeZaiGlm52({ cwd: ctx.cwd, explicitEnvFiles: [path.join(REPO_ROOT, ".env")], timeoutMs: 20_000, retries: 0 } as any);
        doctor.zaiProbe = {
          ok: probe.ok,
          status: probe.status,
          model: probe.model,
          baseUrl: probe.baseUrl,
          latencyMs: probe.latencyMs,
          error: probe.error,
          responseText: probe.text ? probe.text.slice(0, 80).replace(/\s+/g, " ") : "",
          envFiles: probe.envFiles.map((file) => ({ path: file.path, loadedKeys: file.loadedKeys })),
        };
      }
      ctx.ui.notify(args.includes("--json") ? JSON.stringify(doctor, null, 2) : renderDoctorText(doctor), "info");
    },
  });

  pi.registerCommand("harness-mode", {
    description: "Switch harness mode: coding | security-audit",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const requested = args.trim();
      if (requested !== "coding" && requested !== "security-audit") {
        ctx.ui.notify("Usage: /harness-mode coding|security-audit", "warning");
        return;
      }
      uiState.mode = requested;
      uiState.lastUpdatedAt = new Date().toISOString();
      renderStartupUi(pi, ctx, stateManager, uiState);
      ctx.ui.notify(`Harness mode: ${requested}`, "info");
    },
  });

  pi.registerCommand("security-review-status", {
    description: "Show latest read-only production security review status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const review = loadLatestReview();
      if (!review) {
        ctx.ui.notify("No read-only production security review output found yet.", "info");
        return;
      }
      const summary = summarizeReview(review);
      ctx.ui.notify(args.includes("--json") ? JSON.stringify(summary, null, 2) : renderReviewStatus(summary), "info");
    },
  });

  pi.registerCommand("security-review-start", {
    description: "Start the read-only production security review runner (--continuous, --dry-run)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const continuous = args.includes("--continuous");
      const dryRun = args.includes("--dry-run");
      const outputDir = path.join(REPO_ROOT, "ai_docs", "prod_security_review");
      const logDir = path.join(REPO_ROOT, ".pi", "prod-security-review");
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `security-review-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
      const argv = [
        path.join(REPO_ROOT, "scripts", "prod-security-review-readonly.mjs"),
        "--handoff", DEFAULT_REVIEW_HANDOFF,
        "--output-dir", outputDir,
      ];
      if (continuous) argv.push("--continuous");
      else argv.push("--max-iterations", "1");
      if (dryRun) argv.push("--dry-run");
      const out = fs.openSync(logPath, "a");
      const err = fs.openSync(logPath, "a");
      const child = spawn(process.execPath, argv, {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", out, err],
      });
      child.unref();
      ctx.ui.notify(`Read-only security review started pid=${child.pid}. Log: ${logPath}`, "info");
    },
  });
}

async function selectDefaultModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ModelStartupStatus> {
  if (process.env.PI_ITERATIVE_GOAL_AUTO_MODEL === "0") {
    return { selected: false, ok: true, message: "auto model disabled" };
  }
  const model = ctx.modelRegistry.find(ZAI_PROVIDER, ZAI_GLM_5_2_MODEL);
  if (!model) {
    return { selected: false, ok: false, message: `${ZAI_PROVIDER}/${ZAI_GLM_5_2_MODEL} not registered` };
  }
  if (ctx.model?.provider === ZAI_PROVIDER && ctx.model.id === ZAI_GLM_5_2_MODEL) {
    pi.setThinkingLevel("high");
    return { selected: true, ok: true, message: `${ZAI_PROVIDER}/${ZAI_GLM_5_2_MODEL}` };
  }
  const ok = await pi.setModel(model);
  if (ok) {
    pi.setThinkingLevel("high");
    return { selected: true, ok: true, message: `${ZAI_PROVIDER}/${ZAI_GLM_5_2_MODEL}` };
  }
  return { selected: false, ok: false, message: `missing API key for ${ZAI_PROVIDER}/${ZAI_GLM_5_2_MODEL}` };
}

function modelStatusFromContext(ctx: ExtensionContext): ModelStartupStatus {
  const label = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
  return {
    selected: ctx.model?.provider === ZAI_PROVIDER && ctx.model.id === ZAI_GLM_5_2_MODEL,
    ok: Boolean(ctx.model),
    message: label,
  };
}

function renderStartupUi(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  stateManager: StateManagerAPI,
  uiState: HarnessUiState,
): void {
  if (!ctx.hasUI) return;
  const state = stateManager.getState() ?? stateManager.restore(ctx);
  const snapshot = takeCapabilitySnapshot(pi);
  const backend = detectSubagentBackend(pi, snapshot);
  const review = loadLatestReview();
  ctx.ui.setTitle(`pi-iterative-goal ${uiState.model.message}`);
  ctx.ui.setStatus(HARNESS_STATUS_KEY, statusLine(uiState, backend, state));
  ctx.ui.setWidget(HARNESS_WIDGET_KEY, startupLines(uiState, backend, state, review), { placement: "aboveEditor" });
  ctx.ui.setHeader((_tui, theme) => {
    return new HarnessHeader(uiState, backend, state, review, theme);
  });
}

function startupLines(
  uiState: HarnessUiState,
  backend: SubagentBackend,
  state: IterativeGoalState | null,
  review: SecurityReviewSummary | null,
): string[] {
  const reviewSummary = review ? summarizeReview(review) : null;
  return [
    `Harness: pi-iterative-goal loaded · mode=${uiState.mode}`,
    `Model: ${uiState.model.ok ? "ready" : "needs attention"} · ${uiState.model.message}`,
    `Subagents: ${backendLabel(backend)} · roles=scout/planner/worker/reviewer/oracle`,
    state ? `Goal: C${state.cycle} ${state.phase} · ${state.status}` : "Goal: none active · /goal-start <goal>",
    reviewSummary
      ? `Security review: ${reviewSummary.runId} · open=${reviewSummary.openFindings} · readOnly=${reviewSummary.readOnlyEnforced}`
      : "Security review: no latest run · /security-review-start --continuous",
    "Commands: /harness-dashboard · /harness-doctor --json · /harness-mode coding|security-audit · /security-review-status",
  ];
}

function statusLine(uiState: HarnessUiState, backend: SubagentBackend, state: IterativeGoalState | null): string {
  const model = uiState.model.ok ? uiState.model.message : "model attention";
  const goal = state ? `goal C${state.cycle}/${state.phase}` : "no goal";
  return `ig ${uiState.mode} · ${model} · subagents:${backend.kind} · ${goal}`;
}

class HarnessHeader {
  constructor(
    private uiState: HarnessUiState,
    private backend: SubagentBackend,
    private state: IterativeGoalState | null,
    private review: SecurityReviewSummary | null,
    private theme: Theme,
  ) {}

  render(width: number): string[] {
    const w = Math.max(48, width - 4);
    const accent = (text: string) => this.theme.fg("accent", text);
    const dim = (text: string) => this.theme.fg("dim", text);
    const warn = (text: string) => this.theme.fg("warning", text);
    const top = `pi-iterative-goal ${this.uiState.mode}`;
    const model = `${this.uiState.model.ok ? "model" : "model!"}: ${this.uiState.model.message}`;
    const subagents = `subagents: ${backendLabel(this.backend)}`;
    const goal = this.state ? `goal: C${this.state.cycle} ${this.state.phase} ${this.state.status}` : "goal: idle";
    const review = this.review ? `review: ${this.review.runId ?? "latest"}` : "review: ready";
    return [
      "",
      ` ${accent(truncate(top, w))}`,
      ` ${this.uiState.model.ok ? dim(model) : warn(model)}`,
      ` ${dim(truncate(`${subagents} · ${goal} · ${review}`, w))}`,
      "",
    ];
  }

  invalidate(): void {}
}

class HarnessDashboard {
  constructor(
    private uiState: HarnessUiState,
    private state: IterativeGoalState | null,
    private backend: SubagentBackend,
    private review: SecurityReviewSummary | null,
    private theme: Theme,
    private onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (data === "\x1b" || data === "\x03") this.onClose();
  }

  render(width: number): string[] {
    const w = Math.max(54, Math.min(width - 4, 100));
    const lines = [
      "",
      `  ${this.theme.fg("accent", "pi-iterative-goal harness")}`,
      `  ${"-".repeat(Math.min(w, 72))}`,
      `  Mode: ${this.uiState.mode}`,
      `  Model: ${this.uiState.model.message} (${this.uiState.model.ok ? "ready" : "attention"})`,
      `  Env files: ${this.uiState.envFiles.length ? this.uiState.envFiles.map((file) => path.basename(file.path)).join(", ") : "none loaded"}`,
      `  Subagents: ${backendLabel(this.backend)}`,
      `  Roles: scout, planner, worker, reviewer, oracle, context-builder`,
      this.state
        ? `  Active goal: C${this.state.cycle} ${this.state.phase} ${this.state.status} · ${truncate(this.state.goal, w - 18)}`
        : "  Active goal: none",
      "",
      ...renderReviewDashboardLines(this.review),
      "",
      "  Commands:",
      "    /goal-start <goal>",
      "    /harness-doctor --json --probe-zai",
      "    /harness-mode coding|security-audit",
      "    /security-review-status",
      "    /security-review-start --continuous",
      "",
      "  Esc/Ctrl-C closes this dashboard.",
      "",
    ];
    return lines;
  }

  invalidate(): void {}
}

function renderReviewDashboardLines(review: SecurityReviewSummary | null): string[] {
  if (!review) return ["  Security review: no latest run found"];
  const summary = summarizeReview(review);
  return [
    `  Security review: ${summary.runId}`,
    `  Read-only: ${summary.readOnlyEnforced} · secret values read: ${summary.secretValuesRead} · mutations: ${summary.productionMutationsAttempted}`,
    `  Findings: open=${summary.openFindings} new=${summary.newFindings} repeated=${summary.repeatedFindings} resolved=${summary.resolvedFindings}`,
    `  Iterations: ${summary.iterations} · last command status: ${summary.lastCommandStatus}`,
  ];
}

function renderDoctorText(doctor: Record<string, unknown>): string {
  return [
    "pi-iterative-goal harness doctor",
    `loaded: ${doctor.loaded}`,
    `mode: ${doctor.mode}`,
    `model: ${doctor.model}`,
    `targetModel: ${doctor.targetModel}`,
    `subagent: ${doctor.subagent}`,
    `secretsPrinted: ${doctor.secretsPrinted}`,
  ].join("\n");
}

function renderReviewStatus(summary: ReturnType<typeof summarizeReview>): string {
  return [
    `Security review: ${summary.runId}`,
    `readOnly=${summary.readOnlyEnforced} secretValuesRead=${summary.secretValuesRead} productionMutationsAttempted=${summary.productionMutationsAttempted}`,
    `findings open=${summary.openFindings} new=${summary.newFindings} repeated=${summary.repeatedFindings} resolved=${summary.resolvedFindings}`,
    `iterations=${summary.iterations} lastCommandStatus=${summary.lastCommandStatus}`,
  ].join("\n");
}

function loadLatestReview(): SecurityReviewSummary | null {
  const latestPath = path.join(REPO_ROOT, "ai_docs", "prod_security_review", "latest-readonly-review.json");
  if (!fs.existsSync(latestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(latestPath, "utf8")) as SecurityReviewSummary;
  } catch {
    return null;
  }
}

function summarizeReview(review: SecurityReviewSummary) {
  const latestIteration = review.iterations?.at(-1);
  const commands = latestIteration?.commands ?? [];
  const failed = commands.filter((command) => command.status !== "PASS").length;
  return {
    runId: review.runId ?? "unknown",
    mode: review.mode ?? "unknown",
    readOnlyEnforced: review.readOnlyEnforced === true,
    secretValuesRead: review.secretValuesRead === true,
    productionMutationsAttempted: review.productionMutationsAttempted === true,
    openFindings: review.findingSummary?.open ?? 0,
    newFindings: review.findingSummary?.new ?? 0,
    repeatedFindings: review.findingSummary?.repeated ?? 0,
    resolvedFindings: review.findingSummary?.resolved ?? 0,
    iterations: review.iterations?.length ?? 0,
    lastCommandStatus: failed === 0 ? "PASS" : `${failed} failed_or_blocked`,
    finishedAt: review.finishedAt ?? null,
  };
}

function backendLabel(backend: SubagentBackend): string {
  if (backend.kind === "tool") return `tool:${backend.toolName}`;
  if (backend.kind === "command") return `command:${backend.commandName}`;
  return "subprocess:pi";
}

function initialMode(): HarnessMode {
  return process.env.PI_ITERATIVE_GOAL_MODE === "security-audit" ? "security-audit" : "coding";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}
