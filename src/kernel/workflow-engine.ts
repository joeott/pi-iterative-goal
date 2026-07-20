import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import type { StateManagerAPI } from "../state.js";
import type {
  CapabilitySnapshot,
  IterativeGoalState,
  ModelHealthEntry,
  Phase,
  PhaseAttempt,
} from "../types.js";
import { logDebug } from "../logging.js";
import {
  exactModelResponseIdentityError,
  resolveModelRoute,
  type ResolvedModelRoute,
} from "../domain/models.js";

const MODEL_COOLDOWN_MS = 300_000;

export interface ModelSelectionFailure {
  provider: string;
  model: string;
  reason: string;
}

export type PhaseAttemptStartResult =
  | {
      started: true;
      phaseAttemptId: string;
      model: { provider: string; model: string };
      fallbackChain: ModelSelectionFailure[];
    }
  | {
      started: false;
      reason: "provider_unavailable" | "lock_unavailable";
      attempted: ModelSelectionFailure[];
    };

export type ExactModelLoadResult =
  | { loaded: true; route: ResolvedModelRoute }
  | { loaded: false; provider: string; model: string; reason: string };

function log(msg: string) {
  logDebug("workflow", msg);
}

export async function checkModelHealth(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<ModelHealthEntry> {
  const exactRoute = resolveModelRoute({ provider, model: modelId });
  if (!exactRoute) {
    return unavailableHealth(provider, modelId, "Model is not an exact endpoint in the tracked nine-profile roster");
  }

  try {
    const model = ctx.modelRegistry.find(exactRoute.provider, exactRoute.model);
    if (!model) {
      return unavailableHealth(exactRoute.provider, exactRoute.model, "Model not found in registry");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return unavailableHealth(exactRoute.provider, exactRoute.model, "Auth failed or no API key");
    }
    const response = await complete(model, {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Say OK." }], timestamp: Date.now() }],
      systemPrompt: "",
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1, signal: AbortSignal.timeout(15_000) });
    const identityError = exactModelResponseIdentityError(exactRoute, response);
    if (identityError) throw new Error(`Model health response identity failed closed: ${identityError}`);
    return {
      model: exactRoute.model,
      provider: exactRoute.provider,
      lastStatus: "available",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      cooldownUntil: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Model health check failed for ${exactRoute.piSelection}: ${msg}`);
    return unavailableHealth(exactRoute.provider, exactRoute.model, msg);
  }
}

export async function preflightAllModels(
  ctx: ExtensionContext,
  primary: { provider: string; model: string },
  fallbacks: Array<{ provider: string; model: string }>,
): Promise<Record<string, ModelHealthEntry>> {
  const health: Record<string, ModelHealthEntry> = {};
  const seen = new Set<string>();
  const models = [primary, ...fallbacks].filter((model) => {
    const route = resolveModelRoute(model);
    const key = route?.piSelection ?? `${model.provider}/${model.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const entries = await Promise.all(models.map(async (model) => {
    const entry = await checkModelHealth(ctx, model.provider, model.model);
    return { key: `${entry.provider}/${entry.model}`, entry };
  }));
  for (const { key, entry } of entries) {
    health[key] = entry;
    log(`Model preflight ${key}: ${entry.lastStatus}`);
  }
  return health;
}

export function findFirstHealthyFallback(
  state: IterativeGoalState,
  fallbackChain?: Array<{ provider: string; model: string }>,
): { provider: string; model: string } | null {
  const excluded = new Set(
    (fallbackChain ?? [])
      .map((item) => resolveModelRoute(item)?.piSelection)
      .filter((key): key is string => typeof key === "string"),
  );
  for (const fallback of state.config.fallbackModels) {
    const route = resolveModelRoute(fallback);
    if (!route) continue;
    const key = route.piSelection;
    if (isModelInCooldown(state.config.modelHealth[key])) continue;
    if (excluded.has(key)) continue;
    return { provider: route.provider, model: route.model };
  }
  return null;
}

export async function startPhaseAttempt(
  state: IterativeGoalState | null,
  stateManager: StateManagerAPI,
  phase: Phase,
  snapshot: CapabilitySnapshot | null,
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
): Promise<PhaseAttemptStartResult> {
  if (!state) {
    return { started: false, reason: "provider_unavailable", attempted: [] };
  }

  const existingAttempts = state.phaseAttempts.filter(
    (attempt: PhaseAttempt) => attempt.cycle === state.cycle && attempt.phase === phase,
  );
  const attemptNum = existingAttempts.length + 1;
  const phaseAttemptId = `${state.runId}/c${state.cycle}/${phase}/a${attemptNum}`;

  const candidates = orderedConfiguredCandidates(state);
  const fallbackChain: ModelSelectionFailure[] = [];
  let effectiveRoute: ResolvedModelRoute | null = null;

  for (const candidate of candidates) {
    if (!candidate.route) {
      fallbackChain.push({
        provider: candidate.provider,
        model: candidate.model,
        reason: "unlisted or inexact model selector",
      });
      continue;
    }

    const health = state.config.modelHealth[candidate.route.piSelection];
    if (isModelInCooldown(health)) {
      const reason = `health cooldown active until ${health!.cooldownUntil}`;
      fallbackChain.push({
        provider: candidate.route.provider,
        model: candidate.route.model,
        reason,
      });
      log(`Skipping ${candidate.route.piSelection}: ${reason}`);
      continue;
    }

    const load = await loadConfiguredModel(ctx, pi, candidate.route.provider, candidate.route.model);
    if (load.loaded) {
      effectiveRoute = load.route;
      state.config.modelHealth[load.route.piSelection] = availableHealth(load.route.provider, load.route.model);
      break;
    }

    fallbackChain.push({ provider: load.provider, model: load.model, reason: load.reason });
    state.config.modelHealth[`${load.provider}/${load.model}`] = unavailableHealth(
      load.provider,
      load.model,
      load.reason,
    );
    log(`Configured model unavailable: ${load.provider}/${load.model}: ${load.reason}`);
  }

  if (!effectiveRoute) {
    failClosedForProviderUnavailable(state, stateManager, phase, fallbackChain);
    return { started: false, reason: "provider_unavailable", attempted: fallbackChain };
  }

  const attempt: PhaseAttempt = {
    runId: state.runId,
    cycle: state.cycle,
    phase,
    attempt: attemptNum,
    phaseAttemptId,
    modelProvider: effectiveRoute.provider,
    modelModel: effectiveRoute.model,
    fallbackChain,
    startedAt: new Date().toISOString(),
    status: "running",
    outputReceived: false,
    resultParsed: false,
    artifactsPersisted: false,
    resultCommitted: false,
  };

  if (!stateManager.acquireLock(state.runId, phaseAttemptId)) {
    log(`Phase attempt ${phaseAttemptId} did not start: run lock unavailable`);
    return { started: false, reason: "lock_unavailable", attempted: fallbackChain };
  }
  stateManager.startPhaseAttempt(attempt);
  stateManager.persistAll();

  stateManager.recordPhaseEvent({
    runId: state.runId,
    cycle: state.cycle,
    phase,
    phaseAttemptId,
    attempt: attemptNum,
    kind: "phase_started",
    timestamp: new Date().toISOString(),
    details: {
      model: effectiveRoute.piSelection,
      profileId: effectiveRoute.profileId,
      fallbackCount: fallbackChain.length,
    },
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

  return {
    started: true,
    phaseAttemptId,
    model: { provider: effectiveRoute.provider, model: effectiveRoute.model },
    fallbackChain,
  };
}

function isModelInCooldown(health: ModelHealthEntry | undefined): boolean {
  if (!health || health.lastStatus !== "unavailable" || !health.cooldownUntil) return false;
  return new Date(health.cooldownUntil) > new Date();
}

export async function loadConfiguredModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  pi: ExtensionAPI,
  provider: string,
  modelId: string,
): Promise<ExactModelLoadResult> {
  const route = resolveModelRoute({ provider, model: modelId });
  if (!route) {
    const reason = "model selector is not an exact endpoint in the tracked nine-profile roster";
    log(`Refusing configured model ${provider}/${modelId}: ${reason}`);
    return { loaded: false, provider, model: modelId, reason };
  }

  try {
    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) {
      return {
        loaded: false,
        provider: route.provider,
        model: route.model,
        reason: "model not found in Pi registry",
      };
    }
    const selected = await pi.setModel(model);
    if (!selected) {
      return {
        loaded: false,
        provider: route.provider,
        model: route.model,
        reason: "Pi refused model selection (credential unavailable or registry policy denied it)",
      };
    }
    log(`Loaded model: ${route.piSelection}`);
    return { loaded: true, route };
  } catch (error) {
    return {
      loaded: false,
      provider: route.provider,
      model: route.model,
      reason: `registry load failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function orderedConfiguredCandidates(state: IterativeGoalState): Array<{
  provider: string;
  model: string;
  route: ResolvedModelRoute | null;
}> {
  const ordered = [state.config.primaryModel, ...state.config.fallbackModels];
  const seen = new Set<string>();
  const candidates: Array<{ provider: string; model: string; route: ResolvedModelRoute | null }> = [];

  for (const candidate of ordered) {
    const route = resolveModelRoute(candidate);
    const key = route?.piSelection ?? `${candidate.provider}/${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ provider: candidate.provider, model: candidate.model, route });
  }
  return candidates;
}

function availableHealth(provider: string, model: string): ModelHealthEntry {
  return {
    provider,
    model,
    lastStatus: "available",
    lastCheckedAt: new Date().toISOString(),
    error: null,
    cooldownUntil: null,
  };
}

function unavailableHealth(provider: string, model: string, error: string): ModelHealthEntry {
  return {
    provider,
    model,
    lastStatus: "unavailable",
    lastCheckedAt: new Date().toISOString(),
    error,
    cooldownUntil: new Date(Date.now() + MODEL_COOLDOWN_MS).toISOString(),
  };
}

function failClosedForProviderUnavailable(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
  phase: Phase,
  failures: ModelSelectionFailure[],
): void {
  const activePhaseId = state.lock.activePhaseId;
  if (activePhaseId) stateManager.releaseLock(state.runId, activePhaseId);
  state.lock.phaseStatus = "paused";
  stateManager.recordError({
    timestamp: new Date().toISOString(),
    phase,
    cycle: state.cycle,
    kind: "provider_tool_route_incompatible",
    rawText: `No configured model could be loaded: ${failures.map((item) => `${item.provider}/${item.model}: ${item.reason}`).join("; ")}`,
    recoveryAction: "Repair provider credentials or registry configuration, then run /goal-repair-capabilities.",
    resolved: false,
  });
  stateManager.setStatus("provider_unavailable");
  stateManager.persistAll();
  log(`Provider unavailable; phase ${phase} did not start and no phase lock was retained`);
}
