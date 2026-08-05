#!/usr/bin/env node

import { deepStrictEqual, ok, strictEqual as eq, throws } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALLOWED_MODELS,
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_PRIMARY_MODEL,
  MODEL_PROFILE_IDS,
  MODEL_ROSTER,
  canonicalModelKey,
  computeModelRosterHash,
  exactModelResponseIdentityError,
  filterAllowedModels,
  getRouteProfiles,
  isAllowedModel,
  loadModelRoster,
  normalizeConfiguredModel,
  requireModelRoute,
  resolveModelRoute,
  resolveProfileId,
  responseModelMatchesRoute,
} from "../dist/domain/models.js";

eq(MODEL_PROFILE_IDS.length, 12);
eq(MODEL_ROSTER.profiles.length, 12);
eq(ALLOWED_MODELS.length, 12);
deepStrictEqual(MODEL_ROSTER.profiles.map(({ id }) => id), [...MODEL_PROFILE_IDS]);
ok(/^[a-f0-9]{64}$/.test(MODEL_ROSTER.catalogHash));
const { catalogHash: _catalogHash, ...hashInput } = MODEL_ROSTER;
eq(MODEL_ROSTER.catalogHash, computeModelRosterHash(hashInput));
ok(Object.isFrozen(MODEL_ROSTER));

for (const profile of MODEL_ROSTER.profiles) {
  const piSelection = `${profile.provider}/${profile.model}`;
  eq(resolveProfileId(profile.id), profile.id);
  eq(resolveProfileId(piSelection), profile.id);
  eq(resolveProfileId({ provider: profile.provider, model: profile.model }), profile.id);
  const route = requireModelRoute(profile.id);
  eq(route.profileId, profile.id);
  eq(route.piSelection, piSelection);
  eq(route.catalogDate, MODEL_ROSTER.catalogDate);
  eq(route.catalogHash, MODEL_ROSTER.catalogHash);
  ok(Object.isFrozen(route));
  eq(responseModelMatchesRoute(route, route.model), true);
  eq(exactModelResponseIdentityError(route, {
    provider: route.provider,
    model: route.model,
    responseModel: route.model,
  }), null);
  eq(exactModelResponseIdentityError(route, {
    provider: route.provider,
    model: route.model,
  }), "response_model_identity_missing");
  eq(exactModelResponseIdentityError(route, {
    provider: route.provider,
    model: route.model,
    responseModel: "unlisted/substitute",
  }), "response_model_identity_mismatch");
  eq(exactModelResponseIdentityError(route, {
    provider: "unlisted",
    model: route.model,
    responseModel: route.model,
  }), "response_runtime_identity_mismatch");

  eq(profile.pricing.asOf, MODEL_ROSTER.catalogDate);
  eq(profile.pricing.unit, "usd_per_million_tokens");
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    ok(Object.hasOwn(profile.pricing, field), `${profile.id} has explicit ${field} pricing`);
    const value = profile.pricing[field];
    ok(value === null || (Number.isFinite(value) && value >= 0), `${profile.id}.${field} is priced or explicitly unknown`);
  }
}

for (const routeName of [
  "coordinator",
  "research",
  "plan",
  "implement_high_risk",
  "implement_routine",
  "repair",
  "review",
  "evaluate",
]) {
  const profiles = getRouteProfiles(routeName);
  deepStrictEqual(profiles.map(({ profileId }) => profileId), MODEL_ROSTER.routing[routeName]);
  ok(Object.isFrozen(profiles));
}

const zai = requireModelRoute("zai_glm_5_2");
const fireworksMax = requireModelRoute("fireworks_glm_5_2_max");
const fireworksFast = requireModelRoute("fireworks_glm_5_2_fast");
eq(zai.familyId, fireworksMax.familyId);
eq(fireworksMax.familyId, fireworksFast.familyId);
eq(fireworksMax.reasoning.variant, "max");
eq(fireworksMax.reasoning.piThinkingLevel, "xhigh");
eq(fireworksMax.reasoning.providerEffort, "max");
eq(fireworksFast.serving.variant, "fast_router");
eq(fireworksFast.piSelection, "fireworks/accounts/fireworks/routers/glm-5p2-fast");
eq(responseModelMatchesRoute(fireworksFast, "accounts/fireworks/models/glm-5p2"), true);
eq(responseModelMatchesRoute(fireworksMax, "accounts/fireworks/models/glm-5p2"), true);
eq(responseModelMatchesRoute(zai, "accounts/fireworks/models/glm-5p2"), false);
eq(requireModelRoute("openrouter_kimi_k3").piSelection, "openrouter/moonshotai/kimi-k3");
eq(requireModelRoute("openrouter_claude_sonnet_5").piSelection, "openrouter/anthropic/claude-sonnet-5");
eq(requireModelRoute("openrouter_claude_fable_5").piSelection, "openrouter/anthropic/claude-fable-5");
eq(canonicalModelKey(zai), canonicalModelKey(fireworksMax));

deepStrictEqual(DEFAULT_PRIMARY_MODEL, { provider: "zai", model: "glm-5.2" });
deepStrictEqual(DEFAULT_FALLBACK_MODELS, [
  { provider: "fireworks", model: "accounts/fireworks/models/glm-5p2" },
  { provider: "openrouter", model: "moonshotai/kimi-k3" },
]);

for (const selector of [
  "kimi",
  "openrouter/moonshotai/kimi-k3:latest",
  "openrouter/moonshotai/kimi-k3-latest",
  "~openrouter/moonshotai/kimi-k3",
  "openrouter/moonshotai/kimi-*",
  "fireworks/accounts/fireworks/models/glm-5p1",
  "openrouter/openrouter/auto",
  " zai_glm_5_2",
]) {
  eq(resolveProfileId(selector), null, `reject ${selector}`);
  eq(resolveModelRoute(selector), null, `reject ${selector}`);
}
eq(isAllowedModel("zai", "glm-5.2"), true);
eq(isAllowedModel("openrouter", "moonshotai/kimi-k3"), true);
eq(isAllowedModel("openrouter", "moonshotai/kimi-k3:latest"), false);
deepStrictEqual(filterAllowedModels([
  { provider: "cerebras", model: "gpt-oss-120b" },
  { provider: "cerebras", model: "llama-latest" },
]), [{ provider: "cerebras", model: "gpt-oss-120b" }]);
deepStrictEqual(
  normalizeConfiguredModel(
    { provider: "unlisted", model: "latest" },
    { provider: "also-unlisted", model: "latest" },
  ),
  DEFAULT_PRIMARY_MODEL,
);
throws(() => requireModelRoute("latest"), /Unlisted or inexact model selector/);
throws(() => getRouteProfiles("unknown"), /Unknown model route/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-model-roster-"));
const sourceRoster = JSON.parse(fs.readFileSync(new URL("../config/model-roster.json", import.meta.url), "utf8"));
function writeFixture(name, mutate) {
  const fixture = structuredClone(sourceRoster);
  mutate(fixture);
  const fixturePath = path.join(tmp, name);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  return fixturePath;
}

const fuzzyPath = writeFixture("fuzzy.json", (fixture) => {
  fixture.profiles[0].model = "glm-5.2-latest";
});
throws(() => loadModelRoster(fuzzyPath), /fuzzy\/latest syntax/);

const missingPricePath = writeFixture("missing-price.json", (fixture) => {
  delete fixture.profiles[0].pricing.input;
});
throws(() => loadModelRoster(missingPricePath), /non-negative finite number or explicit null/);

const unlistedPath = writeFixture("unlisted.json", (fixture) => {
  fixture.profiles[0].id = "zai_glm_latest";
});
throws(() => loadModelRoster(unlistedPath), /unlisted model profile id/);

const wrongEndpointPath = writeFixture("wrong-endpoint.json", (fixture) => {
  fixture.profiles[0].model = "glm-5.1";
});
throws(() => loadModelRoster(wrongEndpointPath), /must use exact endpoint/);

const credentialExpansionPath = writeFixture("credential-expansion.json", (fixture) => {
  fixture.profiles[0].credential.environment.push("AWS_SECRET_ACCESS_KEY");
});
throws(() => loadModelRoster(credentialExpansionPath), /exact pinned zai environment variables/);

const thirteenthPath = writeFixture("thirteenth.json", (fixture) => {
  fixture.profiles.push({ ...fixture.profiles.at(-1), id: "unlisted_thirteenth_profile" });
});
throws(() => loadModelRoster(thirteenthPath), /exactly 12 profiles/);

console.log("✓ Model roster: exact twelve-profile catalog, fixed routes, prices, hash, and resolvers are valid");
