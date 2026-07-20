import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveModelRoute, type ResolvedModelRoute } from "./domain/model-roster.js";
import { recordModelInvocation, type ModelTermination } from "./model-telemetry.js";
import type { StateManagerAPI } from "./state.js";

interface ActiveTurn {
  turnIndex: number;
  route: ResolvedModelRoute;
  startedMs: number;
  firstTokenMs: number | null;
  requestDigest: string | null;
  cwd: string;
  responseIdentity: "pending" | "valid" | "invalid";
  responseIdentityError: ResponseIdentityError | null;
}

type ResponseIdentityError =
  | "response_runtime_identity_missing"
  | "response_runtime_identity_mismatch"
  | "response_model_mismatch";

interface ResponseIdentityObservation {
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
}

function digest(value: unknown): string {
  const hash = createHash("sha256");
  try { hash.update(JSON.stringify(value)); }
  catch { hash.update(String(value)); }
  return hash.digest("hex");
}

function routeFromContext(ctx: { model?: { provider: string; id: string } }): ResolvedModelRoute | null {
  return ctx.model ? resolveModelRoute({ provider: ctx.model.provider, model: ctx.model.id }) : null;
}

function pricedCost(route: ResolvedModelRoute, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
  const components = [
    [usage.input, route.pricing.input],
    [usage.output, route.pricing.output],
    [usage.cacheRead, route.pricing.cacheRead],
    [usage.cacheWrite, route.pricing.cacheWrite],
  ] as const;
  let total = 0;
  let priced = false;
  for (const [tokens, price] of components) {
    if (!Number.isFinite(tokens) || tokens < 0) return null;
    if (tokens === 0) continue;
    if (price === null) return null;
    priced = true;
    total += (tokens / 1_000_000) * price;
  }
  return priced ? total : null;
}

function terminationFor(stopReason: string | undefined): ModelTermination {
  if (stopReason === "error") return "provider_error";
  if (stopReason === "aborted") return "cancelled";
  if (stopReason === "length") return "gate_failure";
  return "success";
}

function responseMatchesRoute(route: ResolvedModelRoute, responseModel: string | undefined): boolean {
  if (!responseModel) return false;
  if (responseModel === route.model) return true;
  // Fireworks' exact fast router reports the fixed backing GLM 5.2 model in
  // responses; the live probe verifies that one intentional mapping.
  return route.profileId === "fireworks_glm_5_2_fast"
    && responseModel === "accounts/fireworks/models/glm-5p2";
}

function observeResponseIdentity(
  route: ResolvedModelRoute,
  message: ResponseIdentityObservation,
): { valid: boolean; error: ResponseIdentityError | null; observedModel: string | null } {
  const provider = typeof message.provider === "string" && message.provider.length > 0
    ? message.provider
    : null;
  const model = typeof message.model === "string" && message.model.length > 0
    ? message.model
    : null;
  if (!provider || !model) {
    return { valid: false, error: "response_runtime_identity_missing", observedModel: null };
  }
  if (provider !== route.provider || model !== route.model) {
    return { valid: false, error: "response_runtime_identity_mismatch", observedModel: null };
  }
  // Pi's finalized AssistantMessage always carries provider/model, while only
  // some adapters expose the upstream concrete model as responseModel. An
  // omitted optional field is therefore valid; a supplied one remains an
  // additional fail-closed check (including the one verified router mapping).
  if (message.responseModel === undefined) {
    return { valid: true, error: null, observedModel: model };
  }
  if (typeof message.responseModel !== "string" || !responseMatchesRoute(route, message.responseModel)) {
    return { valid: false, error: "response_model_mismatch", observedModel: null };
  }
  return { valid: true, error: null, observedModel: message.responseModel };
}

function exactRequestPayload(payload: unknown, route: ResolvedModelRoute): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const current = payload as Record<string, unknown>;
  return {
    ...current,
    model: route.model,
    ...(route.provider === "openrouter"
      ? {
          provider: {
            ...(current.provider && typeof current.provider === "object" && !Array.isArray(current.provider)
              ? current.provider as Record<string, unknown>
              : {}),
            allow_fallbacks: false,
          },
        }
      : {}),
  };
}

/**
 * Hard request-time roster enforcement plus metadata-only telemetry for every
 * supervisor Pi turn. The model selector is notification-only in Pi, so the
 * before-provider hook is the final authority that prevents an unlisted model
 * from reaching the network even if a built-in catalog entry is enumerable.
 */
export function registerModelRuntimePolicy(pi: ExtensionAPI, stateManager: StateManagerAPI): void {
  let activeTurn: ActiveTurn | null = null;

  pi.on("turn_start", (event, ctx) => {
    const route = routeFromContext(ctx);
    if (!route) {
      stateManager.setStatus("provider_unavailable");
      ctx.abort();
      activeTurn = null;
      return;
    }
    activeTurn = {
      turnIndex: event.turnIndex,
      route,
      startedMs: event.timestamp,
      firstTokenMs: null,
      requestDigest: null,
      cwd: ctx.cwd,
      responseIdentity: "pending",
      responseIdentityError: null,
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const route = routeFromContext(ctx);
    if (!route) {
      stateManager.setStatus("provider_unavailable");
      ctx.abort();
      // Pi catches extension exceptions and would continue. Return a harmless
      // invalid body while the already-aborted signal prevents network I/O.
      return { model: "__PI_ITERATIVE_GOAL_BLOCKED__", messages: [] };
    }
    if (!activeTurn) {
      activeTurn = {
        turnIndex: 0,
        route,
        startedMs: Date.now(),
        firstTokenMs: null,
        requestDigest: null,
        cwd: ctx.cwd,
        responseIdentity: "pending",
        responseIdentityError: null,
      };
    }
    const exactPayload = exactRequestPayload(event.payload, route);
    if (!exactPayload) {
      stateManager.setStatus("provider_unavailable");
      ctx.abort();
      return { model: "__PI_ITERATIVE_GOAL_BLOCKED__", messages: [] };
    }
    activeTurn.route = route;
    // Request bytes are hashed transiently and never emitted as metadata.
    activeTurn.requestDigest = digest(exactPayload);
    return exactPayload;
  });

  pi.on("message_update", () => {
    if (activeTurn && activeTurn.firstTokenMs === null) activeTurn.firstTokenMs = Date.now();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !activeTurn) return;
    const identity = observeResponseIdentity(activeTurn.route, event.message);
    activeTurn.responseIdentity = identity.valid ? "valid" : "invalid";
    activeTurn.responseIdentityError = identity.error;
    if (!identity.valid) {
      stateManager.setStatus("provider_unavailable");
      ctx.abort();
    }
  });

  pi.on("tool_call", () => activeTurn?.responseIdentity === "valid"
    ? undefined
    : { block: true, reason: "coordinator response model identity was not positively validated" });

  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const turn = activeTurn;
    activeTurn = null;
    if (!turn) return;
    const endedMs = Date.now();
    const state = stateManager.getState();
    const usage = event.message.usage;
    const toolCallCount = event.message.content.filter((part) => part.type === "toolCall").length;
    const toolErrorCount = event.toolResults.filter((result) => result.isError).length;
    const identity = observeResponseIdentity(turn.route, event.message);
    const identityError = identity.valid ? null : turn.responseIdentityError ?? identity.error;
    const termination = !identity.valid ? "provider_error" : terminationFor(event.message.stopReason);
    if (!identity.valid && turn.responseIdentity !== "invalid") {
      stateManager.setStatus("provider_unavailable");
      ctx.abort();
    }
    try {
      recordModelInvocation({
        invocationId: randomUUID(),
        runId: state?.runId ?? "session-unscoped",
        sessionId: null,
        cycle: state?.cycle ?? null,
        phase: state?.phase ?? null,
        phaseAttemptId: state?.lock.activePhaseId ?? null,
        taskId: null,
        attempt: turn.turnIndex + 1,
        role: "Coordinator",
        workloadClass: state ? `phase:${state.phase}` : "interactive",
        fixtureHash: null,
        routeId: turn.route.profileId,
        provider: turn.route.provider,
        requestedModel: turn.route.model,
        responseModel: identity.observedModel,
        familyId: turn.route.familyId,
        servingVariant: turn.route.serving.variant,
        reasoningEffort: turn.route.reasoning.variant === "none"
          ? null
          : turn.route.reasoning.providerEffort ?? turn.route.reasoning.piThinkingLevel,
        serviceTier: turn.route.serving.serviceTier,
        fallbackReason: null,
        startedAt: new Date(turn.startedMs).toISOString(),
        firstTokenAt: turn.firstTokenMs === null ? null : new Date(turn.firstTokenMs).toISOString(),
        endedAt: new Date(endedMs).toISOString(),
        latencyMs: Math.max(0, endedMs - turn.startedMs),
        ttftMs: turn.firstTokenMs === null ? null : Math.max(0, turn.firstTokenMs - turn.startedMs),
        outputTokensPerSecond: turn.firstTokenMs !== null && endedMs > turn.firstTokenMs && usage.output > 0
          ? usage.output / ((endedMs - turn.firstTokenMs) / 1_000)
          : null,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        reasoningTokens: null,
        costUsd: pricedCost(turn.route, usage),
        turns: 1,
        toolCallCount,
        toolErrorCount,
        termination,
        gateStatus: !identity.valid ? "FAIL" : "NOT_RUN",
        errorCode: !identity.valid
          ? identityError
          : event.message.errorMessage ? digest(event.message.errorMessage).slice(0, 16) : null,
        requestDigest: turn.requestDigest,
        resultDigest: digest(event.message),
      }, turn.cwd);
    } catch (error) {
      stateManager.setStatus("manual_intervention_required");
      throw error;
    }
  });
}
