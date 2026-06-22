import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { StateManagerAPI } from "../state.js";
import type {
  CapabilitySnapshot,
  IterativeGoalState,
  ModelHealthEntry,
  Phase,
  PhaseAttempt,
} from "../types.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [workflow] ${msg}\n`);
  } catch {}
}

export async function checkModelHealth(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<ModelHealthEntry> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return {
      model: modelId,
      provider,
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: "Model not found in registry",
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      model: modelId,
      provider,
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: "Auth failed or no API key",
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  try {
    const { complete } = require("@earendil-works/pi-ai");
    await complete(model, {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Say OK." }], timestamp: Date.now() }],
      systemPrompt: "",
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1, signal: AbortSignal.timeout(15_000) });
    return {
      model: modelId,
      provider,
      lastStatus: "available",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      cooldownUntil: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Model health check failed for ${provider}/${modelId}: ${msg}`);
    return {
      model: modelId,
      provider,
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: msg,
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
    };
  }
}

export async function preflightAllModels(
  ctx: ExtensionContext,
  primary: { provider: string; model: string },
  fallbacks: Array<{ provider: string; model: string }>,
): Promise<Record<string, ModelHealthEntry>> {
  const health: Record<string, ModelHealthEntry> = {};
  const models = [primary, ...fallbacks];
  for (const model of models) {
    const key = `${model.provider}/${model.model}`;
    health[key] = await checkModelHealth(ctx, model.provider, model.model);
    log(`Model preflight ${key}: ${health[key].lastStatus}`);
  }
  return health;
}

export function findFirstHealthyFallback(
  state: IterativeGoalState,
  fallbackChain?: Array<{ provider: string; model: string }>,
): { provider: string; model: string } | null {
  for (const fallback of state.config.fallbackModels) {
    const key = `${fallback.provider}/${fallback.model}`;
    if (isModelInCooldown(state.config.modelHealth[key])) continue;
    if (fallbackChain && fallbackChain.some((item) => item.provider === fallback.provider && item.model === fallback.model)) continue;
    return fallback;
  }
  return null;
}

export async function startPhaseAttempt(
  state: IterativeGoalState | null,
  stateManager: StateManagerAPI,
  phase: Phase,
  snapshot: CapabilitySnapshot | null,
  pi: ExtensionAPI,
  ctx?: ExtensionContext | ExtensionCommandContext,
): Promise<void> {
  if (!state) return;

  const existingAttempts = state.phaseAttempts.filter(
    (attempt: PhaseAttempt) => attempt.cycle === state.cycle && attempt.phase === phase,
  );
  const attemptNum = existingAttempts.length + 1;
  const phaseAttemptId = `${state.runId}/c${state.cycle}/${phase}/a${attemptNum}`;

  const primaryKey = `${state.config.primaryModel.provider}/${state.config.primaryModel.model}`;
  const primaryHealth = state.config.modelHealth[primaryKey];
  let effectiveModel = state.config.primaryModel;
  const fallbackChain: Array<{ provider: string; model: string; reason: string }> = [];

  if (isModelInCooldown(primaryHealth)) {
    log(`Primary model ${primaryKey} in cooldown; searching fallbacks`);
    const fallback = findFirstHealthyFallback(state);
    if (fallback) {
      fallbackChain.push({ ...effectiveModel, reason: `${primaryKey} in cooldown` });
      effectiveModel = fallback;
      log(`Using fallback: ${fallback.provider}/${fallback.model}`);
    }
  }

  if (ctx) {
    await loadConfiguredModel(ctx, pi, effectiveModel.provider, effectiveModel.model);
  }

  const attempt: PhaseAttempt = {
    runId: state.runId,
    cycle: state.cycle,
    phase,
    attempt: attemptNum,
    phaseAttemptId,
    modelProvider: effectiveModel.provider,
    modelModel: effectiveModel.model,
    fallbackChain,
    startedAt: new Date().toISOString(),
    status: "running",
    outputReceived: false,
    resultParsed: false,
    artifactsPersisted: false,
    resultCommitted: false,
  };

  stateManager.startPhaseAttempt(attempt);
  stateManager.acquireLock(state.runId, phaseAttemptId);

  stateManager.recordPhaseEvent({
    runId: state.runId,
    cycle: state.cycle,
    phase,
    phaseAttemptId,
    attempt: attemptNum,
    kind: "phase_started",
    timestamp: new Date().toISOString(),
    details: { model: `${effectiveModel.provider}/${effectiveModel.model}` },
  });

  stateManager.recordPhaseEvent({
    runId: state.runId,
    cycle: state.cycle,
    phase,
    phaseAttemptId,
    attempt: attemptNum,
    kind: "tool_preflight_recorded",
    timestamp: new Date().toISOString(),
    details: {
      activeTools: snapshot?.activeTools ?? [],
      awsCli: snapshot?.awsCli ?? null,
    },
  });
}

function isModelInCooldown(health: ModelHealthEntry | undefined): boolean {
  if (!health || health.lastStatus !== "unavailable" || !health.cooldownUntil) return false;
  return new Date(health.cooldownUntil) > new Date();
}

async function loadConfiguredModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  pi: ExtensionAPI,
  provider: string,
  modelId: string,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    log(`Configured model not found in registry: ${provider}/${modelId}`);
    return false;
  }
  await pi.setModel(model);
  log(`Loaded model: ${provider}/${modelId}`);
  return true;
}
