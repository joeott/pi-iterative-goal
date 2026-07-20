import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  MODEL_ROSTER,
  getRouteProfiles,
  resolveModelRoute,
  resolveProfileId,
  type ModelProfile,
} from "./model-roster.js";

export {
  MODEL_PROFILE_IDS,
  MODEL_PROFILE_ENDPOINTS,
  MODEL_ROSTER,
  computeModelRosterHash,
  getRouteProfiles,
  loadModelRoster,
  requireModelRoute,
  resolveModelRoute,
  resolveProfileId,
} from "./model-roster.js";
export type {
  LoadedModelRoster,
  ModelPriceSnapshot,
  ModelProfile,
  ModelProfileId,
  ModelRosterFile,
  ModelRouteName,
  PiThinkingLevel,
  ResolvedModelRoute,
} from "./model-roster.js";

export const AllowedModelSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  role: Type.Optional(StringEnum(["primary", "fallback", "evaluator", "reviewer", "router"] as const)),
});

export type AllowedModel = Static<typeof AllowedModelSchema>;

type ModelRole = NonNullable<AllowedModel["role"]>;

function allowedRole(profile: ModelProfile): ModelRole {
  if (profile.id === MODEL_ROSTER.routing.coordinator[0]) return "primary";
  if (profile.id === "openrouter_claude_fable_5") return "evaluator";
  if (profile.eligibleRoles.includes("reviewer")) return "reviewer";
  return "fallback";
}

/** The exact nine-profile allowlist, derived from the validated tracked catalog. */
export const ALLOWED_MODELS: readonly AllowedModel[] = Object.freeze(
  MODEL_ROSTER.profiles.map((profile) => Object.freeze({
    provider: profile.provider,
    model: profile.model,
    role: allowedRole(profile),
  })),
);

const DEFAULT_PRIMARY_ROUTE = getRouteProfiles("coordinator")[0];

export const DEFAULT_PRIMARY_MODEL = Object.freeze({
  provider: DEFAULT_PRIMARY_ROUTE.provider,
  model: DEFAULT_PRIMARY_ROUTE.model,
});

export const DEFAULT_FALLBACK_MODELS: readonly { provider: string; model: string }[] = Object.freeze(
  getRouteProfiles("coordinator").slice(1).map((route) => Object.freeze({
    provider: route.provider,
    model: route.model,
  })),
);

export function modelKey(model: { provider: string; model: string }): string {
  return `${model.provider}/${model.model}`;
}

/**
 * Canonical identity for judge-independence comparisons. Profiles serving the
 * same weights across providers share a roster familyId; unknown endpoints do
 * not gain aliases or fallback behavior.
 */
export function canonicalModelKey(model: { provider: string; model: string }): string {
  return resolveModelRoute(model)?.familyId ?? `${model.provider.toLowerCase()}/${model.model.toLowerCase()}`;
}

export function isAllowedModel(provider: string, model: string): boolean {
  return resolveProfileId({ provider, model }) !== null;
}

export function filterAllowedModels<T extends { provider: string; model: string }>(models: T[]): T[] {
  return models.filter((model) => isAllowedModel(model.provider, model.model));
}

export function normalizeConfiguredModel(
  model: { provider: string; model: string } | undefined,
  fallback: { provider: string; model: string } = DEFAULT_PRIMARY_MODEL,
): { provider: string; model: string } {
  const selected = model ? resolveModelRoute(model) : null;
  if (selected !== null) return { provider: selected.provider, model: selected.model };
  const safeFallback = resolveModelRoute(fallback) ?? DEFAULT_PRIMARY_ROUTE;
  return { provider: safeFallback.provider, model: safeFallback.model };
}
