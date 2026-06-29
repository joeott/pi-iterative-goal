import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const AllowedModelSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  role: Type.Optional(StringEnum(["primary", "fallback", "evaluator", "reviewer", "router"] as const)),
});

export type AllowedModel = Static<typeof AllowedModelSchema>;

export const ALLOWED_MODELS: readonly AllowedModel[] = [
  { provider: "openrouter", model: "deepseek/deepseek-v4-flash", role: "primary" },
  { provider: "openrouter", model: "xiaomi/mimo-v2.5", role: "fallback" },
  { provider: "openrouter", model: "minimax/minimax-m3", role: "fallback" },
  { provider: "openrouter", model: "tencent/hy3-preview", role: "fallback" },
  { provider: "openrouter", model: "openrouter/owl-alpha", role: "fallback" },
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro", role: "evaluator" },
  { provider: "openrouter", model: "anthropic/claude-opus-4.7", role: "reviewer" },
  { provider: "openrouter", model: "anthropic/claude-opus-4.8", role: "reviewer" },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4.6", role: "reviewer" },
  { provider: "openrouter", model: "z-ai/glm-5.2", role: "fallback" },
  { provider: "zai", model: "glm-5.2", role: "fallback" },
  { provider: "openrouter", model: "openrouter/fusion", role: "router" },
  { provider: "openrouter", model: "openrouter/pareto-code", role: "router" },
  { provider: "openrouter", model: "openrouter/auto", role: "router" },
] as const;

export const DEFAULT_PRIMARY_MODEL = { provider: "openrouter", model: "deepseek/deepseek-v4-flash" } as const;

export const DEFAULT_FALLBACK_MODELS = [
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
  { provider: "zai", model: "glm-5.2" },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  { provider: "openrouter", model: "openrouter/fusion" },
] as const;

export function modelKey(model: { provider: string; model: string }): string {
  return `${model.provider}/${model.model}`;
}

export function isAllowedModel(provider: string, model: string): boolean {
  return ALLOWED_MODELS.some((entry) => entry.provider === provider && entry.model === model);
}

export function filterAllowedModels<T extends { provider: string; model: string }>(models: T[]): T[] {
  return models.filter((model) => isAllowedModel(model.provider, model.model));
}

export function normalizeConfiguredModel(
  model: { provider: string; model: string } | undefined,
  fallback: { provider: string; model: string } = DEFAULT_PRIMARY_MODEL,
): { provider: string; model: string } {
  if (model && isAllowedModel(model.provider, model.model)) return model;
  return { ...fallback };
}
