#!/usr/bin/env node

/**
 * Bounded production worker comparison.
 *
 * This is deliberately dry-run by default. A live run requires --live and is
 * hard-limited to two exact roster profiles with at most five samples each.
 * Every live invocation goes through dispatchAgentTask and the production
 * PiSubprocessAgentPool, so worker containment and model telemetry are part of
 * the evidence path. Model response bodies and provider credentials are never
 * copied into the receipt or terminal output.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_PROFILES = Object.freeze([
  "cerebras_gpt_oss_120b",
  "fireworks_glm_5_2_fast",
]);
const MAX_ROUTES = 2;
const MAX_SAMPLES_PER_ROUTE = 5;
const MAX_CALLS = MAX_ROUTES * MAX_SAMPLES_PER_ROUTE;
const FIXTURE_INSTRUCTIONS = [
  "This is a bounded production model-comparison fixture.",
  "Do not call tools, read files, run commands, or modify the workspace.",
  "Reply with one concise sentence confirming that the fixture was received.",
].join(" ");
const FIXTURE_BUDGET = Object.freeze({
  maxTurns: 1,
  maxTokens: 2_048,
  timeoutMs: 120_000,
});

function usage() {
  return [
    "Usage:",
    "  node --env-file-if-exists=.env scripts/live-worker-matrix.mjs [options]",
    "",
    "Options:",
    "  --profiles ID,ID  Exactly two unique model-roster profile IDs",
    "  --samples N        Samples per route (1-5; default: 1)",
    "  --live             Make bounded provider calls (default is dry-run)",
    "  --help             Show this help",
    "",
    `Maximum live calls: ${MAX_ROUTES} routes x ${MAX_SAMPLES_PER_ROUTE} samples = ${MAX_CALLS}.`,
  ].join("\n");
}

function parseArgs(argv) {
  let profiles = [...DEFAULT_PROFILES];
  let samples = 1;
  let live = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") {
      live = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--profiles") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("invalid_profiles_argument");
      profiles = value.split(",");
      index += 1;
    } else if (arg.startsWith("--profiles=")) {
      profiles = arg.slice("--profiles=".length).split(",");
    } else if (arg === "--samples") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("invalid_samples_argument");
      samples = Number(value);
      index += 1;
    } else if (arg.startsWith("--samples=")) {
      samples = Number(arg.slice("--samples=".length));
    } else {
      throw new Error("unknown_argument");
    }
  }

  if (profiles.length !== MAX_ROUTES || new Set(profiles).size !== MAX_ROUTES) {
    throw new Error("profiles_must_be_two_unique_exact_ids");
  }
  if (profiles.some((profile) => !profile || profile.trim() !== profile)) {
    throw new Error("profiles_must_be_two_unique_exact_ids");
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > MAX_SAMPLES_PER_ROUTE) {
    throw new Error("samples_must_be_integer_1_to_5");
  }
  if (profiles.length * samples > MAX_CALLS) throw new Error("live_call_cap_exceeded");

  return { profiles, samples, live, help };
}

function fixtureContractHash() {
  return crypto.createHash("sha256").update(JSON.stringify({
    schema: "pi-iterative-goal.live-worker-matrix-fixture.v1",
    role: "Scout",
    instructions: FIXTURE_INSTRUCTIONS,
    inputArtifactIds: [],
    outputSchema: null,
    permittedEffects: [],
    allowedPaths: [],
    workspace: "read_only_snapshot",
    budget: FIXTURE_BUDGET,
  })).digest("hex");
}

function makeTask(runId, profileId, sampleIndex) {
  return {
    id: `${runId}-${profileId}-${sampleIndex}`,
    role: "Scout",
    instructions: FIXTURE_INSTRUCTIONS,
    inputArtifactIds: [],
    permittedEffects: [],
    allowedPaths: [],
    workspace: "read_only_snapshot",
    modelProfile: profileId,
    dependsOn: [],
    budget: { ...FIXTURE_BUDGET },
  };
}

function catalogPricingStatus(route) {
  const prices = [
    route.pricing.input,
    route.pricing.output,
    route.pricing.cacheRead,
    route.pricing.cacheWrite,
  ];
  return route.pricing.source && prices.every((price) => typeof price === "number")
    ? "catalog_pricing_available"
    : "pricing_unknown";
}

function hasCredential(route) {
  return route.credential.environment.some((name) => (
    typeof process.env[name] === "string" && process.env[name].length > 0
  ));
}

function classifyDriverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) return "build_required";
  if (/managed|telemetry/i.test(message)) return "managed_evidence_error";
  return "matrix_driver_error";
}

function ensureEvidenceDirectory(ensureManagedRoot) {
  const managedRoot = ensureManagedRoot(REPO_ROOT);
  const evidenceRoot = path.join(managedRoot, "evidence", "live-worker-matrix");
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(evidenceRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("managed evidence directory is unsafe");
  return evidenceRoot;
}

function writeReceipt(evidenceRoot, runId, receipt) {
  const receiptPath = path.join(evidenceRoot, `${runId}.json`);
  const temporary = `${receiptPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, receiptPath);
  return receiptPath;
}

function compactComparison(item) {
  return {
    routeId: item.routeId,
    sampleCount: item.sampleCount,
    comparisonRouteCount: item.comparisonRouteCount,
    sufficientData: item.sufficientData,
    successRate: item.successRate,
    medianLatencyMs: item.medianLatencyMs,
    medianTtftMs: item.medianTtftMs,
    medianOutputTokensPerSecond: item.medianOutputTokensPerSecond,
    medianInputTokens: item.medianInputTokens,
    medianOutputTokens: item.medianOutputTokens,
    medianCostUsd: item.medianCostUsd,
  };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  const errorCode = error instanceof Error ? error.message : "invalid_arguments";
  process.stderr.write(`${JSON.stringify({ status: "invalid_arguments", errorCode })}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
}

if (options?.help) {
  process.stdout.write(`${usage()}\n`);
} else if (options) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const runId = `worker-matrix-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
  let pool = null;
  let evidenceRoot = null;
  let receiptPath = null;
  let interrupted = false;
  let receipt = null;

  const abortController = new AbortController();
  const onInterrupt = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  try {
    const [roster, poolModule, runPool, brokerModule, policyModule, telemetry, logging] = await Promise.all([
      import("../dist/domain/model-roster.js"),
      import("../dist/agents/pool.js"),
      import("../dist/agents/run-pool.js"),
      import("../dist/capabilities/broker.js"),
      import("../dist/policy/engine.js"),
      import("../dist/model-telemetry.js"),
      import("../dist/logging.js"),
    ]);

    evidenceRoot = ensureEvidenceDirectory(logging.ensureManagedRoot);
    const routes = options.profiles.map((profileId) => {
      if (!roster.MODEL_PROFILE_IDS.includes(profileId)) throw new Error("unlisted_profile_id");
      return roster.requireModelRoute(profileId);
    });
    const pricingStatuses = routes.map(catalogPricingStatus);
    const pricingStatus = pricingStatuses.every((status) => status === "catalog_pricing_available")
      ? "catalog_pricing_available"
      : "pricing_unknown";

    receipt = {
      schema: "pi-iterative-goal.live-worker-matrix-receipt.v1",
      runId,
      generatedAt: new Date().toISOString(),
      mode: options.live ? "live" : "dry_run",
      status: options.live ? "running" : "planned",
      roster: {
        catalogDate: roster.MODEL_ROSTER.catalogDate,
        catalogHash: roster.MODEL_ROSTER.catalogHash,
        profiles: routes.map((route, index) => ({
          profileId: route.profileId,
          provider: route.provider,
          requestedModel: route.model,
          pricingStatus: pricingStatuses[index],
        })),
      },
      fixture: {
        contractSha256: fixtureContractHash(),
        toolRequirement: "none",
        shellRequirement: "none",
        workspace: "read_only_snapshot",
        budget: { ...FIXTURE_BUDGET },
      },
      bounds: {
        routes: routes.length,
        samplesPerRoute: options.samples,
        plannedCalls: routes.length * options.samples,
        hardCallCap: MAX_CALLS,
        execution: "sequential_round_robin",
      },
      executedCalls: 0,
      pricingStatus,
      usdCost: null,
      usdProof: false,
      results: [],
      comparisonReport: null,
      comparisons: [],
    };

    if (options.live) {
      const missingCredentials = routes
        .filter((route) => !hasCredential(route))
        .map((route) => route.credential.primaryEnv);
      if (missingCredentials.length > 0) {
        receipt.status = "preflight_failed";
        receipt.errorCode = "selected_provider_credential_missing";
        receipt.missingCredentialVariables = missingCredentials;
        process.exitCode = 2;
      } else {
        pool = new poolModule.PiSubprocessAgentPool(REPO_ROOT);
        const broker = new brokerModule.CapabilityBroker(new policyModule.PolicyEngine({ repoRoot: REPO_ROOT }));

        for (let sampleIndex = 1; sampleIndex <= options.samples; sampleIndex += 1) {
          for (const route of routes) {
            if (abortController.signal.aborted) break;
            const task = makeTask(runId, route.profileId, sampleIndex);
            const outcome = await runPool.dispatchAgentTask({
              pool,
              broker,
              stateManager: null,
              runId,
              batchId: `${runId}-batch`,
              mode: "single",
              backend: "pi-subprocess",
              detectedBackend: "pi-subprocess",
              cwd: REPO_ROOT,
              signal: abortController.signal,
            }, task);
            const invocation = telemetry.loadModelInvocations(REPO_ROOT, runId)
              .find((item) => item.taskId === task.id);
            receipt.executedCalls += 1;
            receipt.results.push({
              profileId: route.profileId,
              sampleIndex,
              taskId: task.id,
              status: outcome.status,
              ok: outcome.ok,
              responseModel: invocation?.responseModel ?? null,
              termination: invocation?.termination ?? "telemetry_missing",
              errorCode: invocation?.errorCode ?? (outcome.ok ? null : "dispatch_failed"),
              latencyMs: invocation?.latencyMs ?? null,
              ttftMs: invocation?.ttftMs ?? null,
              inputTokens: invocation?.inputTokens ?? null,
              outputTokens: invocation?.outputTokens ?? null,
              toolCallCount: invocation?.toolCallCount ?? null,
              toolErrorCount: invocation?.toolErrorCount ?? null,
              pricingStatus: catalogPricingStatus(route),
              costUsd: null,
            });
          }
          if (abortController.signal.aborted) break;
        }

        const invocations = telemetry.loadModelInvocations(REPO_ROOT, runId);
        const fixtureHashes = new Set(invocations.map((item) => item.fixtureHash).filter(Boolean));
        const fixtureIdentityValid = invocations.length === receipt.executedCalls && fixtureHashes.size === 1;
        receipt.fixture.telemetryFixtureHash = fixtureHashes.size === 1 ? [...fixtureHashes][0] : null;
        receipt.fixture.identicalAcrossRoutes = fixtureIdentityValid;
        receipt.comparisonReport = path.relative(
          REPO_ROOT,
          telemetry.writeModelComparisonReport(REPO_ROOT, runId, MAX_SAMPLES_PER_ROUTE),
        );
        receipt.comparisons = telemetry
          .compareModelInvocations(invocations, MAX_SAMPLES_PER_ROUTE)
          .map(compactComparison);

        const allSuccessful = receipt.results.length === routes.length * options.samples
          && receipt.results.every((result) => result.ok && result.toolCallCount === 0);
        receipt.status = interrupted
          ? "interrupted"
          : allSuccessful && fixtureIdentityValid
            ? "passed"
            : "completed_with_failures";
        if (!allSuccessful || !fixtureIdentityValid) process.exitCode = interrupted ? 130 : 1;
      }
    }
  } catch (error) {
    const errorCode = classifyDriverError(error);
    receipt = receipt ?? {
      schema: "pi-iterative-goal.live-worker-matrix-receipt.v1",
      runId,
      generatedAt: new Date().toISOString(),
      mode: options.live ? "live" : "dry_run",
      executedCalls: 0,
      pricingStatus: "pricing_unknown",
      usdCost: null,
      usdProof: false,
      results: [],
    };
    receipt.status = "driver_failed";
    receipt.errorCode = errorCode;
    process.exitCode = 1;
  } finally {
    try {
      await pool?.shutdown();
    } catch {
      if (receipt) {
        receipt.status = "shutdown_failed";
        receipt.errorCode = "worker_pool_shutdown_failed";
      }
      process.exitCode = 1;
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);

    if (receipt && evidenceRoot) {
      receipt.generatedAt = new Date().toISOString();
      try {
        receiptPath = writeReceipt(evidenceRoot, runId, receipt);
      } catch {
        process.exitCode = 1;
      }
    }

    const summary = {
      runId,
      mode: options.live ? "live" : "dry_run",
      status: receipt?.status ?? "driver_failed",
      executedCalls: receipt?.executedCalls ?? 0,
      pricingStatus: receipt?.pricingStatus ?? "pricing_unknown",
      usdCost: null,
      receipt: receiptPath ? path.relative(REPO_ROOT, receiptPath) : null,
    };
    const stream = process.exitCode && process.exitCode !== 0 ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(summary)}\n`);
  }
}
