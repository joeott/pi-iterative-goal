import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MODEL_PROFILE_IDS = Object.freeze([
  "zai_glm_5_2",
  "fireworks_glm_5_2_max",
  "fireworks_glm_5_2_fast",
  "openrouter_kimi_k3",
  "cerebras_gpt_oss_120b",
  "cerebras_glm_4_7",
  "cerebras_gemma_4_31b",
  "openrouter_claude_sonnet_5",
  "openrouter_claude_fable_5",
] as const);

export type ModelProfileId = typeof MODEL_PROFILE_IDS[number];

/** Exact provider catalog endpoints and cross-provider weight-family identity. */
export const MODEL_PROFILE_ENDPOINTS: Readonly<Record<ModelProfileId, {
  readonly provider: string;
  readonly model: string;
  readonly familyId: string;
}>> = deepFreeze({
  zai_glm_5_2: { provider: "zai", model: "glm-5.2", familyId: "z-ai/glm-5.2" },
  fireworks_glm_5_2_max: { provider: "fireworks", model: "accounts/fireworks/models/glm-5p2", familyId: "z-ai/glm-5.2" },
  fireworks_glm_5_2_fast: { provider: "fireworks", model: "accounts/fireworks/routers/glm-5p2-fast", familyId: "z-ai/glm-5.2" },
  openrouter_kimi_k3: { provider: "openrouter", model: "moonshotai/kimi-k3", familyId: "moonshotai/kimi-k3" },
  cerebras_gpt_oss_120b: { provider: "cerebras", model: "gpt-oss-120b", familyId: "openai/gpt-oss-120b" },
  cerebras_glm_4_7: { provider: "cerebras", model: "zai-glm-4.7", familyId: "z-ai/glm-4.7" },
  cerebras_gemma_4_31b: { provider: "cerebras", model: "gemma-4-31b", familyId: "google/gemma-4-31b" },
  openrouter_claude_sonnet_5: { provider: "openrouter", model: "anthropic/claude-sonnet-5", familyId: "anthropic/claude-sonnet-5" },
  openrouter_claude_fable_5: { provider: "openrouter", model: "anthropic/claude-fable-5", familyId: "anthropic/claude-fable-5" },
});

/** Credential variable names are capability-bearing and therefore part of
 * the immutable route contract, not operator-editable roster metadata. */
export const MODEL_PROVIDER_CREDENTIALS: Readonly<Record<string, {
  readonly primaryEnv: string;
  readonly environment: readonly string[];
}>> = deepFreeze({
  zai: { primaryEnv: "ZAI_API_KEY", environment: ["ZAI_API_KEY", "Z_AI_API_KEY"] },
  fireworks: { primaryEnv: "FIREWORKS_API_KEY", environment: ["FIREWORKS_API_KEY"] },
  openrouter: { primaryEnv: "OPENROUTER_API_KEY", environment: ["OPENROUTER_API_KEY"] },
  cerebras: { primaryEnv: "CEREBRAS_API_KEY", environment: ["CEREBRAS_API_KEY"] },
});

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelRouteName =
  | "coordinator"
  | "research"
  | "plan"
  | "implement_high_risk"
  | "implement_routine"
  | "repair"
  | "review"
  | "evaluate";

export interface ModelPriceSnapshot {
  asOf: string;
  unit: "usd_per_million_tokens";
  /** Explicit null means the catalog price was not verified; it must never be treated as zero. */
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  source: string | null;
}

export interface ModelProfile {
  id: ModelProfileId;
  provider: string;
  model: string;
  familyId: string;
  credential: {
    primaryEnv: string;
    environment: string[];
  };
  capabilities: {
    tools: boolean;
    structuredOutput: boolean;
    images: boolean;
    reasoning: boolean;
    contextWindow: number;
  };
  reasoning: {
    variant: "none" | "high" | "max";
    piThinkingLevel: PiThinkingLevel;
    providerEffort: string | null;
  };
  serving: {
    variant: "direct" | "standard" | "fast_router" | "openrouter" | "cerebras";
    serviceTier: "standard" | "priority";
  };
  pricing: ModelPriceSnapshot;
  eligibleRoles: string[];
  fallbackProfileIds: ModelProfileId[];
}

export interface ModelRosterFile {
  schemaVersion: 1;
  catalogDate: string;
  profiles: ModelProfile[];
  routing: Record<ModelRouteName, ModelProfileId[]>;
}

export interface LoadedModelRoster extends ModelRosterFile {
  catalogHash: string;
}

/** Fully resolved, exact Pi model selection plus immutable catalog metadata. */
export interface ResolvedModelRoute extends ModelProfile {
  profileId: ModelProfileId;
  piSelection: string;
  catalogDate: string;
  catalogHash: string;
}

export const DEFAULT_MODEL_ROSTER_PATH = fileURLToPath(
  new URL("../../config/model-roster.json", import.meta.url),
);

const PROFILE_ID_SET = new Set<string>(MODEL_PROFILE_IDS);
const ROUTE_NAMES: readonly ModelRouteName[] = [
  "coordinator",
  "research",
  "plan",
  "implement_high_risk",
  "implement_routine",
  "repair",
  "review",
  "evaluate",
];
const FORBIDDEN_SELECTOR = /[?*\[\]~]|(^|[^a-z0-9])latest($|[^a-z0-9])/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const PROFILE_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function loadModelRoster(filePath = DEFAULT_MODEL_ROSTER_PATH): LoadedModelRoster {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read model roster ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRoster(parsed);
  const roster = parsed as ModelRosterFile;
  return deepFreeze({ ...roster, catalogHash: computeModelRosterHash(roster) });
}

export function computeModelRosterHash(roster: ModelRosterFile): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(roster))).digest("hex");
}

function validateRoster(value: unknown): asserts value is ModelRosterFile {
  assertRecord(value, "model roster");
  if (value.schemaVersion !== 1) throw new Error("model roster schemaVersion must be 1");
  assertString(value.catalogDate, "catalogDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.catalogDate)) throw new Error("catalogDate must be YYYY-MM-DD");
  if (!Array.isArray(value.profiles) || value.profiles.length !== MODEL_PROFILE_IDS.length) {
    throw new Error(`model roster must contain exactly ${MODEL_PROFILE_IDS.length} profiles`);
  }

  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    assertRecord(raw, `profiles[${index}]`);
    const id = requiredString(raw.id, `profiles[${index}].id`);
    if (!PROFILE_ID.test(id) || !PROFILE_ID_SET.has(id)) throw new Error(`unlisted model profile id: ${id}`);
    if (ids.has(id)) throw new Error(`duplicate model profile id: ${id}`);
    ids.add(id);

    const provider = requiredString(raw.provider, `${id}.provider`);
    const model = requiredString(raw.model, `${id}.model`);
    const familyId = requiredString(raw.familyId, `${id}.familyId`);
    for (const [label, selector] of [["provider", provider], ["model", model], ["familyId", familyId]] as const) {
      if (selector.trim() !== selector || /\s/.test(selector) || FORBIDDEN_SELECTOR.test(selector)) {
        throw new Error(`${id}.${label} must be exact and may not contain fuzzy/latest syntax`);
      }
    }
    const expectedEndpoint = MODEL_PROFILE_ENDPOINTS[id as ModelProfileId];
    if (
      provider !== expectedEndpoint.provider
      || model !== expectedEndpoint.model
      || familyId !== expectedEndpoint.familyId
    ) {
      throw new Error(
        `${id} must use exact endpoint ${expectedEndpoint.provider}/${expectedEndpoint.model} and family ${expectedEndpoint.familyId}`,
      );
    }
    const endpoint = `${provider}/${model}`;
    if (endpoints.has(endpoint)) throw new Error(`duplicate provider/model endpoint: ${endpoint}`);
    endpoints.add(endpoint);

    assertRecord(raw.credential, `${id}.credential`);
    const primaryEnv = requiredString(raw.credential.primaryEnv, `${id}.credential.primaryEnv`);
    const environment = requiredStringArray(raw.credential.environment, `${id}.credential.environment`);
    if (!ENV_NAME.test(primaryEnv) || !environment.every((name) => ENV_NAME.test(name))) {
      throw new Error(`${id}.credential contains an invalid environment variable name`);
    }
    if (!environment.includes(primaryEnv)) throw new Error(`${id}.credential.environment must include primaryEnv`);
    const expectedCredential = MODEL_PROVIDER_CREDENTIALS[provider];
    if (!expectedCredential
      || primaryEnv !== expectedCredential.primaryEnv
      || JSON.stringify(environment) !== JSON.stringify(expectedCredential.environment)) {
      throw new Error(`${id}.credential must use the exact pinned ${provider} environment variables`);
    }

    assertRecord(raw.capabilities, `${id}.capabilities`);
    for (const name of ["tools", "structuredOutput", "images", "reasoning"] as const) {
      if (typeof raw.capabilities[name] !== "boolean") throw new Error(`${id}.capabilities.${name} must be boolean`);
    }
    if (!Number.isInteger(raw.capabilities.contextWindow) || Number(raw.capabilities.contextWindow) <= 0) {
      throw new Error(`${id}.capabilities.contextWindow must be a positive integer`);
    }

    assertRecord(raw.reasoning, `${id}.reasoning`);
    if (!["none", "high", "max"].includes(String(raw.reasoning.variant))) throw new Error(`${id}.reasoning.variant is invalid`);
    if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(raw.reasoning.piThinkingLevel))) {
      throw new Error(`${id}.reasoning.piThinkingLevel is invalid`);
    }
    if (raw.reasoning.providerEffort !== null && typeof raw.reasoning.providerEffort !== "string") {
      throw new Error(`${id}.reasoning.providerEffort must be string or null`);
    }

    assertRecord(raw.serving, `${id}.serving`);
    if (!["direct", "standard", "fast_router", "openrouter", "cerebras"].includes(String(raw.serving.variant))) {
      throw new Error(`${id}.serving.variant is invalid`);
    }
    if (!["standard", "priority"].includes(String(raw.serving.serviceTier))) throw new Error(`${id}.serving.serviceTier is invalid`);

    assertRecord(raw.pricing, `${id}.pricing`);
    const pricingAsOf = requiredString(raw.pricing.asOf, `${id}.pricing.asOf`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pricingAsOf) || pricingAsOf !== value.catalogDate) {
      throw new Error(`${id}.pricing.asOf must match catalogDate`);
    }
    if (raw.pricing.unit !== "usd_per_million_tokens") throw new Error(`${id}.pricing.unit is invalid`);
    for (const name of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const price = raw.pricing[name];
      if (price !== null && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) {
        throw new Error(`${id}.pricing.${name} must be a non-negative finite number or explicit null`);
      }
    }
    if (raw.pricing.source !== null && (typeof raw.pricing.source !== "string" || raw.pricing.source.length === 0)) {
      throw new Error(`${id}.pricing.source must be a non-empty string or null`);
    }
    requiredStringArray(raw.eligibleRoles, `${id}.eligibleRoles`);
    requiredStringArray(raw.fallbackProfileIds, `${id}.fallbackProfileIds`);
  }

  for (const expected of MODEL_PROFILE_IDS) {
    if (!ids.has(expected)) throw new Error(`model roster is missing required profile: ${expected}`);
  }
  for (const raw of value.profiles) {
    const profile = raw as unknown as ModelProfile;
    for (const fallbackId of profile.fallbackProfileIds) {
      if (!ids.has(fallbackId)) throw new Error(`${profile.id} references unknown fallback: ${fallbackId}`);
      if (fallbackId === profile.id) throw new Error(`${profile.id} may not fall back to itself`);
    }
  }

  assertRecord(value.routing, "routing");
  const routeKeys = Object.keys(value.routing).sort();
  const expectedRouteKeys = [...ROUTE_NAMES].sort();
  if (JSON.stringify(routeKeys) !== JSON.stringify(expectedRouteKeys)) throw new Error("routing must contain exactly the supported route names");
  for (const routeName of ROUTE_NAMES) {
    const route = requiredStringArray(value.routing[routeName], `routing.${routeName}`);
    if (route.length === 0) throw new Error(`routing.${routeName} must not be empty`);
    if (new Set(route).size !== route.length) throw new Error(`routing.${routeName} contains duplicate profiles`);
    for (const profileId of route) {
      if (!ids.has(profileId)) throw new Error(`routing.${routeName} references unknown profile: ${profileId}`);
    }
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function requiredString(value: unknown, label: string): string {
  assertString(value, label);
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const MODEL_ROSTER = loadModelRoster();

const PROFILE_ID_BY_PI_SELECTION = new Map<string, ModelProfileId>(
  MODEL_ROSTER.profiles.map((profile) => [`${profile.provider}/${profile.model}`, profile.id]),
);
const RESOLVED_ROUTE_BY_ID = new Map<ModelProfileId, ResolvedModelRoute>(
  MODEL_ROSTER.profiles.map((profile) => [
    profile.id,
    deepFreeze({
      ...profile,
      profileId: profile.id,
      piSelection: `${profile.provider}/${profile.model}`,
      catalogDate: MODEL_ROSTER.catalogDate,
      catalogHash: MODEL_ROSTER.catalogHash,
    }),
  ]),
);
const ROUTE_PROFILES = ROUTE_NAMES.reduce<Record<ModelRouteName, readonly ResolvedModelRoute[]>>(
  (routes, routeName) => {
    routes[routeName] = deepFreeze(
      MODEL_ROSTER.routing[routeName].map((profileId) => RESOLVED_ROUTE_BY_ID.get(profileId)!),
    );
    return routes;
  },
  {} as Record<ModelRouteName, readonly ResolvedModelRoute[]>,
);

/**
 * Resolve only an exact logical profile id or exact Pi `provider/model` selection.
 * No trimming, aliases, fuzzy matching, `latest`, or family-level substitution occurs.
 */
export function resolveProfileId(
  selector: string | { provider: string; model: string },
): ModelProfileId | null {
  if (typeof selector === "string") {
    if (PROFILE_ID_SET.has(selector)) return selector as ModelProfileId;
    return PROFILE_ID_BY_PI_SELECTION.get(selector) ?? null;
  }
  return PROFILE_ID_BY_PI_SELECTION.get(`${selector.provider}/${selector.model}`) ?? null;
}

/** Resolve an exact selector to its immutable route metadata and Pi selection string. */
export function resolveModelRoute(
  selector: string | { provider: string; model: string },
): ResolvedModelRoute | null {
  const profileId = resolveProfileId(selector);
  return profileId === null ? null : RESOLVED_ROUTE_BY_ID.get(profileId) ?? null;
}

/** Resolve an exact selector, throwing when the selector is not one of the nine catalog profiles. */
export function requireModelRoute(
  selector: string | { provider: string; model: string },
): ResolvedModelRoute {
  const resolved = resolveModelRoute(selector);
  if (resolved === null) {
    const rendered = typeof selector === "string" ? selector : `${selector.provider}/${selector.model}`;
    throw new Error(`Unlisted or inexact model selector: ${rendered}`);
  }
  return resolved;
}

/** Return the immutable, fixed-order fallback chain for a supported route. */
export function getRouteProfiles(routeName: ModelRouteName): readonly ResolvedModelRoute[] {
  if (!ROUTE_NAMES.includes(routeName)) throw new Error(`Unknown model route: ${String(routeName)}`);
  return ROUTE_PROFILES[routeName];
}
