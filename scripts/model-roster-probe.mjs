#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_CREDENTIALS,
  EXPECTED_PROFILES,
  PROVIDERS,
  REPOSITORY_ROOT,
  createModelProbeRequest,
  loadRoster,
} from "./lib/model-runtime.mjs";

const PROBE_NAMES = ["catalog", "auth", "completion", "structured", "tools"];
const options = parseArgs(process.argv.slice(2));
const roster = loadRoster(options.roster);
const profiles = selectProfiles(roster.profiles, options.profiles);
const requestedProbes = options.probes.length ? options.probes : PROBE_NAMES;
const secretValues = ALLOWED_CREDENTIALS.map((name) => process.env[name]).filter((value) => value && value.length >= 8);
const catalogCache = new Map();
const results = [];

for (const profile of profiles) {
  results.push(await probeProfile(profile));
}

const evidence = {
  schema: "pi-iterative-goal.model-roster-probe.v1",
  generatedAt: new Date().toISOString(),
  live: options.live,
  networkCallsPermitted: options.live,
  roster: {
    schemaVersion: roster.schemaVersion,
    catalogDate: roster.catalogDate,
    catalogHash: roster.catalogHash,
    profileCount: roster.profiles.length,
  },
  requestedProbes,
  results,
  summary: summarize(results),
};
const outputPath = resolveOutputPath(options.output);
writeEvidence(outputPath, evidence);

console.log("model_roster_probe");
console.log(`mode: ${options.live ? "live" : "offline"}`);
console.log(`network_calls_permitted: ${String(options.live)}`);
console.log(`profiles: ${profiles.length}`);
console.log(`probes: ${requestedProbes.join(",")}`);
console.log(`pass: ${evidence.summary.pass}`);
console.log(`warn: ${evidence.summary.warn}`);
console.log(`fail: ${evidence.summary.fail}`);
console.log(`not_run: ${evidence.summary.notRun}`);
console.log(`evidence: ${outputPath}`);
if (!options.live) console.log("live_calls: SKIPPED (--live was not supplied)");
if (evidence.summary.fail > 0) process.exitCode = 1;

async function probeProfile(profile) {
  const credentialPresent = Boolean(process.env[profile.credential.primaryEnv]);
  const probes = {};
  if (!options.live) {
    for (const name of requestedProbes) probes[name] = { status: "not_run", reason: "live flag not supplied" };
    return profileResult(profile, credentialPresent, probes);
  }

  let catalog = null;
  if (requestedProbes.includes("catalog") || requestedProbes.includes("auth")) {
    if (credentialPresent) catalog = await getCatalog(profile);
    else catalog = { ok: false, httpStatus: null, modelIds: [], error: "credential unavailable" };
  }
  if (requestedProbes.includes("catalog")) {
    const listed = Boolean(catalog?.ok && catalog.modelIds.includes(profile.model));
    const routerNotListed = catalog?.ok && !listed && profile.serving?.variant === "fast_router";
    probes.catalog = !catalog?.ok
      ? { status: "fail", httpStatus: catalog?.httpStatus ?? null, modelListed: false, error: redact(catalog?.error ?? "catalog request failed") }
      : listed
        ? { status: "pass", httpStatus: catalog.httpStatus, modelListed: true }
        : routerNotListed
          ? { status: "warn", httpStatus: catalog.httpStatus, modelListed: false, reason: "router route is not enumerated by provider catalog; completion proof required" }
          : { status: "fail", httpStatus: catalog.httpStatus, modelListed: false, error: "exact model id absent from provider catalog" };
  }

  for (const name of ["completion", "structured", "tools"]) {
    if (!requestedProbes.includes(name)) continue;
    if (!credentialPresent) {
      probes[name] = { status: "fail", httpStatus: null, error: "credential unavailable" };
      continue;
    }
    probes[name] = await runChatProbe(profile, name);
  }
  if (requestedProbes.includes("auth")) {
    const inference = [probes.completion, probes.structured, probes.tools].filter(Boolean);
    const authenticated = inference.some((probe) => probe.httpStatus !== null && ![401, 403].includes(probe.httpStatus));
    const rejected = inference.some((probe) => [401, 403].includes(probe.httpStatus));
    probes.auth = !credentialPresent
      ? { status: "fail", httpStatus: null, error: "credential unavailable" }
      : authenticated
        ? { status: "pass", httpStatus: inference.find((probe) => probe.httpStatus)?.httpStatus ?? null }
        : rejected
          ? { status: "fail", httpStatus: inference.find((probe) => [401, 403].includes(probe.httpStatus))?.httpStatus ?? null, error: "authenticated inference was rejected" }
          : catalog?.ok
            ? { status: "warn", httpStatus: catalog.httpStatus, reason: "catalog may be public; run an inference probe for authentication proof" }
            : { status: "fail", httpStatus: catalog?.httpStatus ?? null, error: redact(catalog?.error ?? "authentication could not be verified") };
  }
  return profileResult(profile, credentialPresent, probes);
}

function profileResult(profile, credentialPresent, probes) {
  return {
    profileId: profile.id,
    provider: profile.provider,
    requestedModel: profile.model,
    familyId: profile.familyId,
    servingVariant: profile.serving.variant,
    reasoningEffort: profile.reasoning.providerEffort,
    credentialEnv: profile.credential.primaryEnv,
    credentialPresent,
    probes,
  };
}

async function getCatalog(profile) {
  if (!catalogCache.has(profile.provider)) {
    catalogCache.set(profile.provider, requestJson(`${PROVIDERS[profile.provider].baseUrl}/models`, {
      method: "GET",
      headers: authorizationHeaders(profile),
    }).then((response) => ({
      ...response,
      modelIds: response.ok ? extractModelIds(response.body) : [],
      body: undefined,
    })));
  }
  return catalogCache.get(profile.provider);
}

async function runChatProbe(profile, kind) {
  const requestBody = createModelProbeRequest(profile, kind);
  const response = await requestJson(`${PROVIDERS[profile.provider].baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...authorizationHeaders(profile), "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    return { status: "fail", httpStatus: response.httpStatus, latencyMs: response.latencyMs, error: redact(response.error ?? "request failed") };
  }
  const responseModel = typeof response.body?.model === "string" ? response.body.model : null;
  const expectedResponseModel = profile.serving?.variant === "fast_router"
    ? "accounts/fireworks/models/glm-5p2"
    : profile.model;
  const modelMatches = responseModel === expectedResponseModel;
  const choice = response.body?.choices?.[0];
  const content = extractText(choice?.message?.content);
  let behaviorMatches = false;
  if (kind === "completion") behaviorMatches = content.trim().length > 0;
  else if (kind === "structured") {
    try { behaviorMatches = JSON.parse(content)?.ok === true; } catch { behaviorMatches = false; }
  } else {
    behaviorMatches = Array.isArray(choice?.message?.tool_calls)
      && choice.message.tool_calls.some((call) => call?.function?.name === "emit_probe");
  }
  const usage = response.body?.usage ?? {};
  return {
    status: modelMatches && behaviorMatches ? "pass" : "fail",
    httpStatus: response.httpStatus,
    latencyMs: response.latencyMs,
    responseModel,
    expectedResponseModel,
    exactModelMatch: modelMatches,
    providerFallbackDisabled: profile.provider === "openrouter"
      ? requestBody.provider?.allow_fallbacks === false
      : null,
    behaviorMatch: behaviorMatches,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: {
      inputTokens: finiteNumber(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: finiteNumber(usage.completion_tokens ?? usage.output_tokens),
      totalTokens: finiteNumber(usage.total_tokens),
    },
    ...(!modelMatches ? { error: "provider response model did not exactly match requested model" } : {}),
    ...(modelMatches && !behaviorMatches ? { error: `${kind} behavior contract was not satisfied` } : {}),
  };
}

function authorizationHeaders(profile) {
  return { authorization: `Bearer ${process.env[profile.credential.primaryEnv]}` };
}

async function requestJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const latencyMs = Math.round(performance.now() - started);
    let body = null;
    try { body = JSON.parse(await response.text()); } catch { /* response content is deliberately discarded */ }
    return response.ok
      ? { ok: true, httpStatus: response.status, latencyMs, body }
      : { ok: false, httpStatus: response.status, latencyMs, body: null, error: `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      httpStatus: null,
      latencyMs: Math.round(performance.now() - started),
      body: null,
      error: timedOut ? `timeout after ${options.timeoutMs}ms` : redact(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractModelIds(body) {
  const candidates = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return candidates.map((item) => typeof item === "string" ? item : item?.id).filter((id) => typeof id === "string");
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function redact(value) {
  let output = String(value ?? "unknown error");
  for (const secret of secretValues) output = output.split(secret).join("[REDACTED]");
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/(?:sk-(?:or-v1-)?|fw_)[A-Za-z0-9._-]{8,}/gi, "[REDACTED_API_KEY]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 512);
}

function summarize(items) {
  const summary = { pass: 0, warn: 0, fail: 0, notRun: 0 };
  for (const item of items) {
    for (const probe of Object.values(item.probes)) {
      if (probe.status === "pass") summary.pass += 1;
      else if (probe.status === "warn") summary.warn += 1;
      else if (probe.status === "fail") summary.fail += 1;
      else summary.notRun += 1;
    }
  }
  return summary;
}

function selectProfiles(allProfiles, requested) {
  if (!requested.length) return allProfiles;
  for (const id of requested) if (!EXPECTED_PROFILES[id]) throw new Error(`unknown profile: ${id}`);
  return allProfiles.filter((profile) => requested.includes(profile.id));
}

function resolveOutputPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const managedRoot = path.join(REPOSITORY_ROOT, ".pi", "iterative-goal", "managed");
  ensureManagedRoot(managedRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(managedRoot, "evidence", "model-probes", `${stamp}.json`);
}

function ensureManagedRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`managed evidence root must be a real directory: ${root}`);
  const ownerPath = path.join(root, "owner.json");
  if (!fs.existsSync(ownerPath)) {
    fs.writeFileSync(ownerPath, `${JSON.stringify({
      schema: "pi-iterative-goal.managed-root.v1",
      owner: "pi-iterative-goal",
      createdAt: new Date().toISOString(),
      repository: REPOSITORY_ROOT,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  if (owner.owner !== "pi-iterative-goal") throw new Error(`managed evidence owner mismatch: ${root}`);
}

function writeEvidence(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`refusing to replace symlink: ${filePath}`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  for (const secret of secretValues) if (serialized.includes(secret)) throw new Error("refusing to persist a credential value");
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, serialized, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseArgs(args) {
  const result = { live: false, profiles: [], probes: [], timeoutMs: 30000, roster: undefined, output: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--live") result.live = true;
    else if (arg === "--profile") result.profiles.push(requireValue(args, ++index, arg));
    else if (arg === "--probe") result.probes.push(...requireValue(args, ++index, arg).split(",").filter(Boolean));
    else if (arg === "--timeout-ms") result.timeoutMs = Number(requireValue(args, ++index, arg));
    else if (arg === "--roster") result.roster = path.resolve(requireValue(args, ++index, arg));
    else if (arg === "--output") result.output = path.resolve(requireValue(args, ++index, arg));
    else if (arg === "--help") {
      console.log("usage: model-roster-probe.mjs [--live] [--profile ID] [--probe catalog,auth,completion,structured,tools] [--timeout-ms N] [--output FILE]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 120000) {
    throw new Error("--timeout-ms must be an integer from 1000 through 120000");
  }
  for (const probe of result.probes) if (!PROBE_NAMES.includes(probe)) throw new Error(`unknown probe: ${probe}`);
  result.probes = [...new Set(result.probes)];
  result.profiles = [...new Set(result.profiles)];
  return result;
}

function requireValue(args, index, flag) {
  if (!args[index]) throw new Error(`${flag} requires a value`);
  return args[index];
}
