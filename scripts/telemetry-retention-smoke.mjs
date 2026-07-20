#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logging = await import("../dist/logging.js");
const retention = await import("../dist/log-retention.js");
const telemetry = await import("../dist/model-telemetry.js");
const runtimePolicy = await import("../dist/model-runtime-policy.js");
const pool = await import("../dist/agents/pool.js");
const runPool = await import("../dist/agents/run-pool.js");
const { CapabilityBroker } = await import("../dist/capabilities/broker.js");
const { PolicyEngine } = await import("../dist/policy/engine.js");
const worktrees = await import("../dist/workspace/worktrees.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-observability-"));
try {
  const secret = "sk-or-v1-super-secret-value-123456789";
  for (let index = 0; index < 12; index += 1) {
    logging.appendManagedLog("smoke", "test", `event ${index} OPENROUTER_API_KEY=${secret}`, {
      cwd: root,
      rotateBytes: 600,
      rotations: 3,
      required: true,
    });
  }
  const logDir = path.join(root, ".pi", "iterative-goal", "managed", "logs");
  const active = fs.readFileSync(path.join(logDir, "smoke.jsonl"), "utf8");
  assert(!active.includes(secret), "active log redacts API keys");
  assert(fs.readdirSync(logDir).filter((name) => /^smoke\.jsonl\.\d+\.gz$/.test(name)).length <= 3, "rotation is bounded");

  const outsideManagedRoot = path.join(root, "outside-managed-root.jsonl");
  assert.throws(
    () => logging.appendManagedLog("escape", "test", "must not escape", {
      cwd: root,
      path: outsideManagedRoot,
      required: true,
    }),
    /escapes the owned root/,
  );
  assert.equal(fs.existsSync(outsideManagedRoot), false, "custom log path cannot escape the owned managed root");

  const externalDirectory = path.join(root, "external-log-target");
  fs.mkdirSync(externalDirectory);
  const linkedDirectory = path.join(root, ".pi", "iterative-goal", "managed", "linked-logs");
  fs.symlinkSync(externalDirectory, linkedDirectory, "dir");
  assert.throws(
    () => logging.appendManagedLog("escape", "test", "must not follow parent symlink", {
      cwd: root,
      path: path.join(linkedDirectory, "escaped.jsonl"),
      required: true,
    }),
    /not a real directory|resolves outside/,
  );
  assert.equal(fs.existsSync(path.join(externalDirectory, "escaped.jsonl")), false, "parent symlink cannot redirect a log write");

  const foreignRoot = path.join(root, "foreign-repository");
  logging.appendManagedLog("owner", "test", "seed", { cwd: foreignRoot, required: true });
  const foreignOwner = path.join(foreignRoot, ".pi", "iterative-goal", "managed", "owner.json");
  const mismatchedOwner = JSON.parse(fs.readFileSync(foreignOwner, "utf8"));
  mismatchedOwner.owner = "someone-else";
  fs.writeFileSync(foreignOwner, JSON.stringify(mismatchedOwner));
  assert.throws(
    () => logging.appendManagedLog("owner", "test", "must fail closed", { cwd: foreignRoot, required: true }),
    /owner marker does not match/,
  );

  const concurrentRoot = path.join(root, "concurrent-repository");
  const workerScript = path.resolve("scripts/logging-concurrency-worker.mjs");
  const concurrentWorkers = 12;
  const eventsPerWorker = 60;
  // Give every child time to load before a shared cold-start deadline. This
  // deliberately exercises both legitimate directory-creation contention and
  // the lock release-versus-lstat window on every smoke run.
  const concurrentStartAt = Date.now() + 1_500;
  await Promise.all(Array.from({ length: concurrentWorkers }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerScript,
      concurrentRoot,
      "concurrent",
      String(eventsPerWorker),
      String(concurrentStartAt),
    ], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`logging worker exit ${code}: ${stderr}`)));
  })));
  const concurrentPath = path.join(concurrentRoot, ".pi", "iterative-goal", "managed", "logs", "concurrent.jsonl");
  const concurrentRows = fs.readFileSync(concurrentPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const expectedConcurrentEvents = concurrentWorkers * eventsPerWorker;
  assert.equal(concurrentRows.length, expectedConcurrentEvents);
  for (let index = 0; index < concurrentRows.length; index += 1) {
    assert.equal(concurrentRows[index].sequence, index + 1, "multiprocess sequence is gapless and unique");
    assert.equal(concurrentRows[index].previousHash, index === 0 ? null : concurrentRows[index - 1].hash, "multiprocess hash link is intact");
  }
  assert.equal(JSON.parse(fs.readFileSync(`${concurrentPath}.head.json`, "utf8")).sequence, expectedConcurrentEvents);

  const baseInvocation = {
    invocationId: "invocation",
    runId: "run-smoke",
    sessionId: null,
    cycle: 1,
    phase: "implement",
    phaseAttemptId: "run-smoke/c1/implement/a1",
    taskId: "task-smoke",
    attempt: 1,
    role: "Implementer",
    workloadClass: "smoke-fixture",
    fixtureHash: "fixture-sha256",
    routeId: "fireworks_glm_5_2_fast",
    provider: "fireworks",
    requestedModel: "accounts/fireworks/routers/glm-5p2-fast",
    responseModel: "accounts/fireworks/routers/glm-5p2-fast",
    familyId: "z-ai/glm-5.2",
    servingVariant: "fast_router",
    reasoningEffort: "high",
    serviceTier: "standard",
    fallbackReason: null,
    startedAt: new Date().toISOString(),
    firstTokenAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    latencyMs: 100,
    ttftMs: 20,
    outputTokensPerSecond: 100,
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    costUsd: null,
    turns: 1,
    toolCallCount: 1,
    toolErrorCount: 0,
    termination: "success",
    gateStatus: "PASS",
    errorCode: null,
    requestDigest: "request-sha256",
    resultDigest: "result-sha256",
  };
  for (let index = 0; index < 5; index += 1) {
    telemetry.recordModelInvocation({ ...baseInvocation, invocationId: `invocation-${index}`, latencyMs: 100 + index }, root);
  }
  const comparisons = telemetry.compareModelInvocations(telemetry.loadModelInvocations(root, "run-smoke"));
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].sampleCount, 5);
  assert.equal(comparisons[0].sufficientData, false, "one route alone is never called a model comparison");
  assert.equal(comparisons[0].comparisonRouteCount, 1);
  const pairedComparisonInput = telemetry.loadModelInvocations(root, "run-smoke");
  pairedComparisonInput.push(...pairedComparisonInput.map((item, index) => ({
    ...item,
    invocationId: `comparison-peer-${index}`,
    routeId: "zai_glm_5_2",
    provider: "zai",
    requestedModel: "glm-5.2",
    responseModel: "glm-5.2",
  })));
  const pairedComparisons = telemetry.compareModelInvocations(pairedComparisonInput);
  assert.equal(pairedComparisons.length, 2);
  assert(pairedComparisons.every((item) => item.sufficientData && item.comparisonRouteCount === 2));
  assert.equal(comparisons[0].medianCostUsd, null, "unknown price never becomes zero");
  assert(fs.existsSync(telemetry.writeModelComparisonReport(root, "run-smoke")));

  const telemetryDirectory = path.join(root, ".pi", "iterative-goal", "managed", "telemetry", "invocations");
  fs.writeFileSync(
    path.join(telemetryDirectory, "oversized-line.jsonl"),
    `${"x".repeat(telemetry.MAX_TELEMETRY_LINE_BYTES + 1)}\n`,
  );
  assert.throws(
    () => telemetry.loadModelInvocations(root, "oversized-line"),
    /Telemetry line exceeds/,
    "comparison loading fails closed on an oversized telemetry record",
  );
  const telemetryOutside = path.join(root, "outside-telemetry.jsonl");
  fs.writeFileSync(telemetryOutside, "{}\n");
  fs.symlinkSync(telemetryOutside, path.join(telemetryDirectory, "linked-run.jsonl"));
  assert.throws(
    () => telemetry.loadModelInvocations(root, "linked-run"),
    /not a real regular file/,
    "comparison loading never follows a telemetry symlink",
  );

  // Supervisor turns are also measured, and the request-time hook is the
  // final network boundary for the exact-nine model policy.
  const runtimeEvents = new Map();
  const runtimeStatuses = [];
  const runtimePi = { on(name, handler) { runtimeEvents.set(name, handler); } };
  const runtimeStateManager = {
    getState() {
      return {
        runId: "run-coordinator",
        cycle: 2,
        phase: "plan",
        lock: { activePhaseId: "run-coordinator/c2/plan/a1" },
      };
    },
    setStatus(status) { runtimeStatuses.push(status); },
  };
  runtimePolicy.registerModelRuntimePolicy(runtimePi, runtimeStateManager);
  const runtimeCtx = { cwd: root, model: { provider: "zai", id: "glm-5.2" } };
  const requestOnlySecret = "REQUEST_BODY_MUST_NOT_PERSIST_187bf0";
  const responseOnlySecret = "RESPONSE_BODY_MUST_NOT_PERSIST_719c3a";
  runtimeEvents.get("turn_start")({ turnIndex: 0, timestamp: Date.now() - 50 }, runtimeCtx);
  runtimeEvents.get("before_provider_request")({ payload: { messages: [{ content: requestOnlySecret }] } }, runtimeCtx);
  runtimeEvents.get("message_update")({}, runtimeCtx);
  const coordinatorMessage = {
      role: "assistant",
      provider: "zai",
      model: "glm-5.2",
      responseModel: "glm-5.2",
      content: [{ type: "text", text: responseOnlySecret }, { type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
      usage: { input: 21, output: 7, cacheRead: 2, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
  };
  runtimeEvents.get("message_end")({ message: coordinatorMessage }, runtimeCtx);
  assert.equal(runtimeEvents.get("tool_call")({ toolName: "read", input: { path: "goal.md" } }, runtimeCtx), undefined);
  runtimeEvents.get("turn_end")({
    message: coordinatorMessage,
    toolResults: [{ isError: false }],
  }, runtimeCtx);
  const coordinatorTelemetry = telemetry.loadModelInvocations(root, "run-coordinator");
  assert.equal(coordinatorTelemetry.length, 1);
  assert.equal(coordinatorTelemetry[0].routeId, "zai_glm_5_2");
  assert.equal(coordinatorTelemetry[0].inputTokens, 21);
  assert.equal(coordinatorTelemetry[0].toolCallCount, 1);
  const coordinatorBytes = fs.readFileSync(
    path.join(root, ".pi", "iterative-goal", "managed", "telemetry", "invocations", "run-coordinator.jsonl"),
    "utf8",
  );
  assert(!coordinatorBytes.includes(requestOnlySecret));
  assert(!coordinatorBytes.includes(responseOnlySecret));
  let blockedAbortCount = 0;
  const blockedPayload = runtimeEvents.get("before_provider_request")(
    { payload: { messages: [] } },
    { cwd: root, model: { provider: "anthropic", id: "not-on-roster" }, abort() { blockedAbortCount += 1; } },
  );
  assert.equal(blockedAbortCount, 1, "unlisted runtime route aborts before provider fetch");
  assert.equal(blockedPayload.model, "__PI_ITERATIVE_GOAL_BLOCKED__");
  assert.equal(runtimeStatuses.at(-1), "provider_unavailable");

  const openRouterCtx = {
    cwd: root,
    model: { provider: "openrouter", id: "moonshotai/kimi-k3" },
    abort() { throw new Error("approved OpenRouter route must not abort"); },
  };
  runtimeEvents.get("turn_start")({ turnIndex: 1, timestamp: Date.now() }, openRouterCtx);
  const openRouterPayload = runtimeEvents.get("before_provider_request")({
    payload: { model: "ambient-alias", messages: [], provider: { allow_fallbacks: true, order: ["x"] } },
  }, openRouterCtx);
  assert.equal(openRouterPayload.model, "moonshotai/kimi-k3", "request model is rewritten to the exact roster id");
  assert.equal(openRouterPayload.provider.allow_fallbacks, false, "OpenRouter provider fallback is disabled in Pi payloads");
  let mismatchAbortCount = 0;
  const mismatchMessage = {
      role: "assistant",
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
      responseModel: "some/other-model",
      content: [{ type: "text", text: "mismatch" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
  };
  const mismatchCtx = { ...openRouterCtx, abort() { mismatchAbortCount += 1; } };
  runtimeEvents.get("message_end")({ message: mismatchMessage }, mismatchCtx);
  assert.equal(runtimeEvents.get("tool_call")({ toolName: "read", input: { path: "goal.md" } }, mismatchCtx).block, true);
  runtimeEvents.get("turn_end")({
    message: mismatchMessage,
    toolResults: [],
  }, mismatchCtx);
  assert.equal(mismatchAbortCount, 1, "response-model substitution fails before tool execution");
  const mismatchTelemetry = telemetry.loadModelInvocations(root, "run-coordinator").at(-1);
  assert.equal(mismatchTelemetry.termination, "provider_error");
  assert.equal(mismatchTelemetry.gateStatus, "FAIL");
  assert.equal(mismatchTelemetry.errorCode, "response_model_mismatch");

  runtimeEvents.get("turn_start")({ turnIndex: 2, timestamp: Date.now() }, openRouterCtx);
  runtimeEvents.get("before_provider_request")({ payload: { messages: [] } }, openRouterCtx);
  let nativeShapeAbortCount = 0;
  const nativeShapeMessage = {
    role: "assistant",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    content: [{ type: "toolCall", id: "native-shape", name: "read", arguments: {} }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
  };
  const nativeShapeCtx = { ...openRouterCtx, abort() { nativeShapeAbortCount += 1; } };
  runtimeEvents.get("message_end")({ message: nativeShapeMessage }, nativeShapeCtx);
  assert.equal(runtimeEvents.get("tool_call")({ toolName: "read", input: { path: "goal.md" } }, nativeShapeCtx).block, true);
  runtimeEvents.get("turn_end")({ message: nativeShapeMessage, toolResults: [] }, nativeShapeCtx);
  assert.equal(nativeShapeAbortCount, 1, "missing upstream model identity fails before coordinator tool execution");
  const nativeShapeTelemetry = telemetry.loadModelInvocations(root, "run-coordinator").at(-1);
  assert.equal(nativeShapeTelemetry.responseModel, null);
  assert.equal(nativeShapeTelemetry.errorCode, "response_model_identity_missing");

  runtimeEvents.get("turn_start")({ turnIndex: 3, timestamp: Date.now() }, openRouterCtx);
  runtimeEvents.get("before_provider_request")({ payload: { messages: [] } }, openRouterCtx);
  let missingIdentityAbortCount = 0;
  const missingIdentityMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "missing-id", name: "read", arguments: {} }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
  };
  const missingIdentityCtx = { ...openRouterCtx, abort() { missingIdentityAbortCount += 1; } };
  runtimeEvents.get("message_end")({ message: missingIdentityMessage }, missingIdentityCtx);
  assert.equal(runtimeEvents.get("tool_call")({ toolName: "read", input: { path: "goal.md" } }, missingIdentityCtx).block, true);
  runtimeEvents.get("turn_end")({ message: missingIdentityMessage, toolResults: [] }, missingIdentityCtx);
  assert.equal(missingIdentityAbortCount, 1, "missing runtime identity fails before tool execution");
  assert.equal(telemetry.loadModelInvocations(root, "run-coordinator").at(-1).errorCode, "response_runtime_identity_missing");

  runtimeEvents.get("turn_start")({ turnIndex: 4, timestamp: Date.now() }, openRouterCtx);
  runtimeEvents.get("before_provider_request")({ payload: { messages: [] } }, openRouterCtx);
  let runtimeMismatchAbortCount = 0;
  const runtimeMismatchMessage = {
    ...nativeShapeMessage,
    provider: "zai",
    model: "glm-5.2",
    content: [{ type: "toolCall", id: "runtime-mismatch", name: "read", arguments: {} }],
  };
  const runtimeMismatchCtx = { ...openRouterCtx, abort() { runtimeMismatchAbortCount += 1; } };
  runtimeEvents.get("message_end")({ message: runtimeMismatchMessage }, runtimeMismatchCtx);
  assert.equal(runtimeEvents.get("tool_call")({ toolName: "read", input: { path: "goal.md" } }, runtimeMismatchCtx).block, true);
  runtimeEvents.get("turn_end")({ message: runtimeMismatchMessage, toolResults: [] }, runtimeMismatchCtx);
  assert.equal(runtimeMismatchAbortCount, 1, "provider/model substitution fails before tool execution");
  assert.equal(telemetry.loadModelInvocations(root, "run-coordinator").at(-1).errorCode, "response_runtime_identity_mismatch");

  // The real dispatch boundary resolves the exact roster route before its
  // ledger start and writes metadata-only terminal telemetry. Unique prompt
  // and result strings must contribute only to their SHA-256 digests.
  const startedRecords = [];
  const finishedRecords = [];
  const stateManager = {
    getState() {
      return {
        runId: "run-dispatch",
        cycle: 3,
        phase: "implement",
        lock: { activePhaseId: "run-dispatch/c3/implement/a1" },
      };
    },
    recordSubagentStarted(record) { startedRecords.push(record); },
    recordSubagentFinished(taskId, finish) { finishedRecords.push({ taskId, ...finish }); },
  };
  const uniquePrompt = "PROMPT_CONTENT_MUST_NOT_BE_PERSISTED_44ff6f";
  const uniqueOutput = "OUTPUT_CONTENT_MUST_NOT_BE_PERSISTED_a81c20";
  const successTask = pool.createAgentTask("Scout", uniquePrompt, {
    id: "dispatch-success",
    outputSchema: {
      type: "object",
      required: ["claims", "sources", "confidence", "unknowns"],
      properties: {
        claims: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        unknowns: { type: "array", items: { type: "string" } },
      },
    },
  });
  const successResult = {
    taskId: successTask.id,
    role: successTask.role,
    ok: true,
    outputText: uniqueOutput,
    structuredOutput: { claims: ["ok"], sources: ["fixture"], confidence: 1, unknowns: [] },
    exitCode: 0,
    stderr: "",
    responseModel: "gpt-oss-120b",
    toolCallCount: 2,
    toolErrorCount: 1,
    timing: {
      startedAt: "2026-07-20T12:00:00.000Z",
      firstTokenAt: "2026-07-20T12:00:00.100Z",
      endedAt: "2026-07-20T12:00:01.100Z",
      latencyMs: 1100,
      ttftMs: 100,
    },
    usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, cost: 99, turns: 2 },
  };
  let submitCount = 0;
  const successPool = {
    async submit() { submitCount += 1; return successResult; },
    async map() { throw new Error("not used"); },
    async cancel() { return "unknown"; },
    wasCancelled() { return false; },
  };
  const dispatchDeps = {
    pool: successPool,
    broker: new CapabilityBroker(new PolicyEngine({ repoRoot: root })),
    stateManager,
    runId: "run-dispatch",
    batchId: "batch-dispatch",
    mode: "single",
    backend: "pi-subprocess",
    detectedBackend: "none",
    cwd: root,
  };
  const dispatched = await runPool.dispatchAgentTask(dispatchDeps, successTask);
  assert.equal(dispatched.ok, true);
  assert.equal(submitCount, 1);
  assert.equal(startedRecords.length, 1);
  assert.equal(startedRecords[0].routeId, "cerebras_gpt_oss_120b");
  assert.equal(startedRecords[0].provider, "cerebras");
  assert.equal(startedRecords[0].requestedModel, "gpt-oss-120b");
  assert.equal(startedRecords[0].familyId, "openai/gpt-oss-120b");
  assert.equal(startedRecords[0].fallbackReason, null);

  const dispatchedTelemetry = telemetry.loadModelInvocations(root, "run-dispatch");
  assert.equal(dispatchedTelemetry.length, 1);
  const successfulInvocation = dispatchedTelemetry[0];
  assert.equal(successfulInvocation.termination, "success");
  assert.equal(successfulInvocation.inputTokens, 12, "input token counter round-trips through managed logging");
  assert.equal(successfulInvocation.outputTokens, 4, "output token counter round-trips through managed logging");
  assert.equal(successfulInvocation.cacheReadTokens, 2, "cache token counter round-trips through managed logging");
  assert.equal(successfulInvocation.cacheWriteTokens, 1, "cache-write token counter round-trips through managed logging");
  assert.equal(successfulInvocation.costUsd, null, "unknown catalog prices stay null despite a provider cost field");
  assert.equal(successfulInvocation.outputTokensPerSecond, 4);
  assert.equal(successfulInvocation.responseModel, "gpt-oss-120b");
  assert.equal(successfulInvocation.toolCallCount, 2);
  assert.equal(successfulInvocation.toolErrorCount, 1);
  assert.equal(successfulInvocation.gateStatus, "PASS", "schema-valid typed worker output is a passed gate");
  assert.match(successfulInvocation.fixtureHash, /^[a-f0-9]{64}$/, "comparison fixture is stable and route-independent");
  assert.match(successfulInvocation.requestDigest, /^[a-f0-9]{64}$/);
  assert.match(successfulInvocation.resultDigest, /^[a-f0-9]{64}$/);
  const dispatchTelemetryBytes = fs.readFileSync(
    path.join(root, ".pi", "iterative-goal", "managed", "telemetry", "invocations", "run-dispatch.jsonl"),
    "utf8",
  );
  assert(!dispatchTelemetryBytes.includes(uniquePrompt), "prompt content is absent from telemetry");
  assert(!dispatchTelemetryBytes.includes(uniqueOutput), "result content is absent from telemetry");

  const missingWorkerIdentityTask = pool.createAgentTask("Scout", "missing response identity", {
    id: "dispatch-missing-identity",
  });
  const missingWorkerIdentityPool = {
    ...successPool,
    async submit() {
      return { ...successResult, taskId: missingWorkerIdentityTask.id, responseModel: null };
    },
  };
  const missingWorkerIdentity = await runPool.dispatchAgentTask(
    { ...dispatchDeps, pool: missingWorkerIdentityPool },
    missingWorkerIdentityTask,
  );
  assert.equal(missingWorkerIdentity.ok, false, "controller requires a positive worker response identity");
  assert.equal(
    telemetry.loadModelInvocations(root, "run-dispatch").find((item) => item.taskId === missingWorkerIdentityTask.id)?.errorCode,
    "response_model_identity_missing",
  );

  // Cancellation before pool admission is represented as a zero-token
  // terminal record and never calls submit.
  const cancelledTask = pool.createAgentTask("Scout", "cancel before admission", { id: "dispatch-cancelled" });
  let cancelledSubmitCount = 0;
  const cancelledPool = {
    async submit() { cancelledSubmitCount += 1; return successResult; },
    async map() { throw new Error("not used"); },
    async cancel() { return "queued"; },
    wasCancelled() { return true; },
  };
  const cancelled = await runPool.dispatchAgentTask({ ...dispatchDeps, pool: cancelledPool }, cancelledTask);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelledSubmitCount, 0);
  const afterCancellation = telemetry.loadModelInvocations(root, "run-dispatch");
  const cancelledInvocation = afterCancellation.find((item) => item.taskId === cancelledTask.id);
  assert(cancelledInvocation, "cancel-before-start telemetry exists");
  assert.equal(cancelledInvocation.termination, "cancelled");
  assert.equal(cancelledInvocation.inputTokens, 0);
  assert.equal(cancelledInvocation.outputTokens, 0);
  assert.equal(cancelledInvocation.firstTokenAt, null);

  // Required telemetry is a production gate. A successful worker result is
  // reported failed when the owned telemetry root cannot be created.
  const unwritableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-telemetry-fail-"));
  try {
    fs.writeFileSync(path.join(unwritableRoot, ".pi"), "not a directory");
    const failClosedFinished = [];
    const failClosedState = {
      getState: stateManager.getState,
      recordSubagentStarted() {},
      recordSubagentFinished(taskId, finish) { failClosedFinished.push({ taskId, ...finish }); },
    };
    const failClosed = await runPool.dispatchAgentTask({
      ...dispatchDeps,
      cwd: unwritableRoot,
      stateManager: failClosedState,
    }, pool.createAgentTask("Scout", "telemetry must persist", { id: "dispatch-fail-closed" }));
    assert.equal(failClosed.ok, false);
    assert.equal(failClosed.status, "failed");
    assert.match(failClosed.policyError, /^required_model_telemetry_failed:/);
    assert.equal(failClosedFinished.at(-1).status, "failed");
  } finally {
    fs.rmSync(unwritableRoot, { recursive: true, force: true });
  }

  const managed = logging.ensureManagedRoot(root);
  const stale = path.join(managed, "runs", "old-run", "raw", "success.completed.log.gz");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "stale");
  const protectedEvidence = path.join(managed, "evidence", "receipt.completed.log.gz");
  fs.mkdirSync(path.dirname(protectedEvidence), { recursive: true });
  fs.writeFileSync(protectedEvidence, "preserve");
  const outside = path.join(root, "outside.log");
  fs.writeFileSync(outside, "outside");
  const link = path.join(managed, "runs", "old-run", "raw", "outside.completed.log.gz");
  fs.symlinkSync(outside, link);
  const expiredTelemetry = path.join(managed, "telemetry", "invocations", "expired-run.jsonl");
  fs.mkdirSync(path.dirname(expiredTelemetry), { recursive: true });
  fs.writeFileSync(expiredTelemetry, "{}\n");
  fs.writeFileSync(`${expiredTelemetry}.head.json`, "{}\n");
  const expiredAt = new Date(Date.now() - retention.TELEMETRY_TTL_MS - 60_000);
  fs.utimesSync(expiredTelemetry, expiredAt, expiredAt);
  const future = Date.now() + retention.SUCCESS_RAW_TTL_MS + 1;
  const orphanRaw = path.join(managed, "runs", "crashed-run", "raw", "rpc-events.jsonl");
  fs.mkdirSync(path.dirname(orphanRaw), { recursive: true });
  fs.writeFileSync(orphanRaw, "orphaned active-name bytes\n");
  fs.utimesSync(orphanRaw, expiredAt, expiredAt);
  const liveRaw = path.join(managed, "runs", "live-run", "raw", "rpc-events.jsonl");
  const liveMarker = path.join(managed, "runs", "live-run", "ACTIVE");
  fs.mkdirSync(path.dirname(liveRaw), { recursive: true });
  fs.writeFileSync(liveRaw, "live active-name bytes\n");
  fs.writeFileSync(liveMarker, "owned\n");
  fs.utimesSync(liveRaw, expiredAt, expiredAt);
  fs.utimesSync(liveMarker, new Date(future), new Date(future));
  const retentionReport = retention.runManagedLogRetention(root, future);
  assert.equal(fs.existsSync(stale), false, "owned expired raw log is purged");
  assert.equal(fs.existsSync(protectedEvidence), true, "evidence is retained");
  assert.equal(fs.existsSync(outside), true, "symlink target outside managed root is untouched");
  assert.equal(fs.existsSync(expiredTelemetry), false, "inactive run telemetry expires even when it never reached rotation size");
  assert.equal(fs.existsSync(`${expiredTelemetry}.head.json`), false, "expired telemetry chain head is removed with its bytes");
  assert.equal(fs.existsSync(orphanRaw), false, "a crashed run's active-name raw JSONL cannot evade retention");
  assert.equal(fs.existsSync(liveRaw), true, "a fresh owned ACTIVE marker protects a live run's raw JSONL");
  assert(retentionReport.bytesDeleted >= 5);
  fs.unlinkSync(liveMarker);
  retention.runManagedLogRetention(root, future + retention.RETENTION_INTERVAL_MS * 2 + 1);
  assert.equal(fs.existsSync(liveRaw), false, "completed/stale runs re-enter raw TTL and cap accounting");

  // Production-harness evidence has a separate, ownership-scoped policy. It
  // keeps a useful recent success/failure window, protects active/current and
  // pinned evidence, but expires older runs and enforces hard run/aggregate
  // caps without broadening deletion to arbitrary evidence.
  const productionEvidenceRoot = path.join(managed, "evidence");
  const evidenceNow = future + retention.RETENTION_INTERVAL_MS * 4;
  const touchTree = (target, timestamp) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) touchTree(path.join(target, name), timestamp);
    }
    fs.utimesSync(target, new Date(timestamp), new Date(timestamp));
  };
  const makeProductionEvidence = ({ namespace = "prod-runtime-confirmation", id, status, timestamp, bytes = 1, pinned = false }) => {
    const directory = path.join(productionEvidenceRoot, namespace, id);
    fs.mkdirSync(directory, { recursive: true });
    if (status !== "incomplete") {
      const result = namespace === "prod-feature-matrix"
        ? { executionStatus: status === "success" ? "PASS" : "FAIL" }
        : { overall: status === "success" ? "PASS" : "FAIL" };
      fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(result));
    }
    const payload = path.join(directory, "payload.bin");
    fs.writeFileSync(payload, "");
    fs.truncateSync(payload, bytes);
    if (pinned) fs.writeFileSync(path.join(directory, "PINNED"), "retain\n");
    touchTree(directory, timestamp);
    return { directory, payload };
  };

  const oldSuccesses = Array.from({ length: retention.RECENT_PRODUCTION_SUCCESSES_TO_KEEP + 2 }, (_, index) => (
    makeProductionEvidence({
      id: `expired-success-${index}`,
      status: "success",
      timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_SUCCESS_TTL_MS - (index + 1) * 1_000,
    })
  ));
  const oldFailures = Array.from({ length: retention.RECENT_PRODUCTION_FAILURES_TO_KEEP + 2 }, (_, index) => (
    makeProductionEvidence({
      id: `expired-failure-${index}`,
      status: "failure",
      timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_FAILURE_TTL_MS - (index + 1) * 1_000,
    })
  ));
  const pinnedEvidence = makeProductionEvidence({
    id: "expired-pinned-success",
    status: "success",
    timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_SUCCESS_TTL_MS - 60_000,
    pinned: true,
  });
  const activeEvidence = makeProductionEvidence({
    id: "expired-active-failure",
    status: "failure",
    timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_FAILURE_TTL_MS - 60_000,
  });
  const activeEvidenceMarker = path.join(managed, "runs", "expired-active-failure", "ACTIVE");
  fs.mkdirSync(path.dirname(activeEvidenceMarker), { recursive: true });
  fs.writeFileSync(activeEvidenceMarker, "owned\n");
  fs.utimesSync(activeEvidenceMarker, new Date(evidenceNow), new Date(evidenceNow));
  const livePidEvidence = makeProductionEvidence({
    id: "expired-live-pid-failure",
    status: "failure",
    timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_FAILURE_TTL_MS - 90_000,
  });
  const livePidMarker = path.join(managed, "runs", "expired-live-pid-failure", "ACTIVE");
  fs.mkdirSync(path.dirname(livePidMarker), { recursive: true });
  fs.writeFileSync(livePidMarker, `${process.pid}\n`);
  fs.utimesSync(
    livePidMarker,
    new Date(evidenceNow - retention.RETENTION_INTERVAL_MS * 3),
    new Date(evidenceNow - retention.RETENTION_INTERVAL_MS * 3),
  );
  makeProductionEvidence({
    namespace: "prod-feature-matrix",
    id: "current-matrix-success",
    status: "success",
    timestamp: evidenceNow,
  });
  const structurallyProtectedEvidence = makeProductionEvidence({
    namespace: "prod-feature-matrix",
    id: "protected-structure",
    status: "incomplete",
    timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_INCOMPLETE_TTL_MS - 120_000,
  });
  fs.writeFileSync(path.join(structurallyProtectedEvidence.directory, "owner.json"), "{}\n");
  fs.writeFileSync(path.join(structurallyProtectedEvidence.directory, "artifact.head.json"), "{}\n");
  fs.mkdirSync(path.join(structurallyProtectedEvidence.directory, "heads"));
  fs.mkdirSync(path.join(structurallyProtectedEvidence.directory, "aggregates"));
  fs.writeFileSync(path.join(structurallyProtectedEvidence.directory, "aggregates", "summary.json"), "{}\n");
  touchTree(structurallyProtectedEvidence.directory, evidenceNow - retention.PRODUCTION_EVIDENCE_INCOMPLETE_TTL_MS - 120_000);
  const incompleteEvidence = makeProductionEvidence({
    namespace: "prod-feature-matrix",
    id: "expired-incomplete-matrix",
    status: "incomplete",
    timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_INCOMPLETE_TTL_MS - 60_000,
  });
  const evidenceTtlReport = retention.runManagedLogRetention(root, evidenceNow);
  assert.equal(oldSuccesses.filter(({ directory }) => fs.existsSync(directory)).length, retention.RECENT_PRODUCTION_SUCCESSES_TO_KEEP);
  assert.equal(oldFailures.filter(({ directory }) => fs.existsSync(directory)).length, retention.RECENT_PRODUCTION_FAILURES_TO_KEEP);
  assert.equal(fs.existsSync(pinnedEvidence.directory), true, "PINNED production evidence survives TTL");
  assert.equal(fs.existsSync(activeEvidence.directory), true, "a matching fresh run marker protects active production evidence");
  assert.equal(fs.existsSync(livePidEvidence.directory), true, "a still-live harness PID protects evidence after its heartbeat ages out");
  assert.equal(fs.existsSync(structurallyProtectedEvidence.directory), true, "owner, head, and aggregate evidence is never purged");
  assert.equal(fs.existsSync(incompleteEvidence.directory), false, "abandoned feature-matrix evidence expires");
  assert(evidenceTtlReport.deleted.some(({ reason }) => reason === "evidence_ttl"), "evidence TTL deletions are classified");

  fs.unlinkSync(activeEvidenceMarker);
  fs.unlinkSync(livePidMarker);
  retention.runManagedLogRetention(root, evidenceNow + retention.RETENTION_INTERVAL_MS * 2 + 1);
  assert.equal(fs.existsSync(activeEvidence.directory), false, "stale evidence is eligible after its matching ACTIVE marker disappears");
  assert.equal(fs.existsSync(livePidEvidence.directory), false, "live-PID evidence is eligible after its marker disappears");

  const currentEvidence = makeProductionEvidence({
    id: "current-success",
    status: "success",
    timestamp: evidenceNow + retention.RETENTION_INTERVAL_MS * 3,
  });
  const oversizedEvidence = makeProductionEvidence({
    id: "oversized-old-success",
    status: "success",
    timestamp: evidenceNow - 10 * 24 * 60 * 60_000,
    bytes: retention.PRODUCTION_EVIDENCE_RUN_CAP_BYTES + 1,
  });
  const runCapReport = retention.runManagedLogRetention(root, evidenceNow + retention.RETENTION_INTERVAL_MS * 3);
  assert.equal(fs.existsSync(oversizedEvidence.directory), false, "an old oversized production receipt is purged as one bounded run");
  assert(runCapReport.deleted.some(({ reason }) => reason === "evidence_run_cap"), "per-run evidence cap deletion is classified");
  assert.equal(fs.existsSync(currentEvidence.directory), true, "the newest production receipt is protected as current");

  const aggregateRuns = Array.from({ length: 5 }, (_, index) => makeProductionEvidence({
    namespace: "prod-feature-matrix",
    id: `aggregate-pressure-${index}`,
    status: "success",
    timestamp: evidenceNow - (5 + index) * 24 * 60 * 60_000,
    bytes: 110 * 1024 * 1024,
  }));
  const aggregateReport = retention.runManagedLogRetention(root, evidenceNow + retention.RETENTION_INTERVAL_MS * 3 + 1);
  assert(aggregateReport.deleted.some(({ reason }) => reason === "evidence_total_cap"), "aggregate production-evidence cap deletion is classified");
  assert(aggregateRuns.some(({ directory }) => !fs.existsSync(directory)), "aggregate cap purges the oldest eligible matrix evidence");
  const journalEvents = fs.readFileSync(path.join(managed, "logs", "retention.journal.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert(journalEvents.some((event) => event.metadata?.deleted?.some?.(({ reason }) => reason === "evidence_total_cap")), "evidence deletion reasons are journaled");

  fs.truncateSync(currentEvidence.payload, retention.PRODUCTION_EVIDENCE_RUN_CAP_BYTES + 1);
  touchTree(currentEvidence.directory, evidenceNow + retention.RETENTION_INTERVAL_MS * 4);
  const protectedEvidencePressure = retention.runManagedLogRetention(root, evidenceNow + retention.RETENTION_INTERVAL_MS * 4);
  assert.equal(fs.existsSync(currentEvidence.directory), true, "current oversized evidence is never deleted to hide pressure");
  assert.equal(protectedEvidencePressure.blocked, true, "current evidence above its run cap fails health closed");
  assert(protectedEvidencePressure.reasons.some((reason) => reason.includes("exceed run cap")));
  fs.truncateSync(currentEvidence.payload, 1);

  const symlinkEvidence = makeProductionEvidence({
    namespace: "prod-feature-matrix",
    id: "unsafe-symlink-run",
    status: "failure",
    timestamp: evidenceNow - retention.PRODUCTION_EVIDENCE_FAILURE_TTL_MS - 120_000,
  });
  const symlinkOutside = path.join(root, "evidence-symlink-target.txt");
  fs.writeFileSync(symlinkOutside, "outside must survive\n");
  fs.symlinkSync(symlinkOutside, path.join(symlinkEvidence.directory, "outside-link"));
  const unsafeEvidenceReport = retention.runManagedLogRetention(root, evidenceNow + retention.RETENTION_INTERVAL_MS * 4 + 1);
  assert.equal(fs.existsSync(symlinkOutside), true, "evidence retention never follows a symlink outside its owned root");
  assert.equal(unsafeEvidenceReport.blocked, true, "unsafe production evidence fails health closed");
  assert(unsafeEvidenceReport.reasons.some((reason) => reason.includes("contains a symlink")));
  fs.unlinkSync(path.join(symlinkEvidence.directory, "outside-link"));
  fs.rmSync(symlinkEvidence.directory, { recursive: true });
  retention.runManagedLogRetention(root, evidenceNow + retention.RETENTION_INTERVAL_MS * 4 + 2);

  const linkedEvidenceRepo = path.join(root, "linked-evidence-repository");
  const linkedManaged = logging.ensureManagedRoot(linkedEvidenceRepo);
  const linkedEvidenceTarget = path.join(root, "linked-evidence-target");
  const linkedTargetRun = path.join(linkedEvidenceTarget, "prod-runtime-confirmation", "old-run");
  fs.mkdirSync(linkedTargetRun, { recursive: true });
  fs.writeFileSync(path.join(linkedTargetRun, "results.json"), JSON.stringify({ overall: "PASS" }));
  touchTree(linkedTargetRun, evidenceNow - retention.PRODUCTION_EVIDENCE_SUCCESS_TTL_MS - 60_000);
  fs.symlinkSync(linkedEvidenceTarget, path.join(linkedManaged, "evidence"), "dir");
  const linkedEvidenceReport = retention.runManagedLogRetention(linkedEvidenceRepo, evidenceNow);
  assert.equal(fs.existsSync(linkedTargetRun), true, "an ancestor evidence symlink cannot redirect retention into another tree");
  assert.equal(linkedEvidenceReport.blocked, true, "an in-root ancestor symlink fails retention closed");
  assert(linkedEvidenceReport.reasons.some((reason) => reason.includes("exact owned directory")));

  const protectedPressure = path.join(managed, "evidence", "protected-pressure.bin");
  fs.writeFileSync(protectedPressure, "");
  fs.truncateSync(protectedPressure, retention.TOTAL_MANAGED_CAP_BYTES + 1);
  const pressureReport = retention.runManagedLogRetention(root, future + 1);
  assert.equal(fs.existsSync(protectedPressure), true, "protected evidence is never purged to hide pressure");
  assert.equal(pressureReport.blocked, true, "protected evidence over the managed cap fails logging health closed");
  assert(pressureReport.reasons.some((reason) => reason.includes("protected evidence was retained")));
  fs.unlinkSync(protectedPressure);
  retention.runManagedLogRetention(root, future + 2);

  const workerEnv = pool.buildWorkerEnvironment({
    PATH: "/usr/bin",
    OPENROUTER_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "must-not-leak",
    RANDOM_UNRELATED_SECRET: "must-not-leak",
  });
  assert.equal(workerEnv.OPENROUTER_API_KEY, "secret");
  assert.equal(workerEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(workerEnv.RANDOM_UNRELATED_SECRET, undefined);
  assert.equal(workerEnv.PI_TELEMETRY, "0");
  const args = pool.buildPiSubprocessArgs(pool.createAgentTask("Scout", "inspect"));
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) assert(args.includes(flag));

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-capture-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const workspace = worktrees.prepareIsolatedWorktree(repo, "complete-capture");
  try {
    fs.writeFileSync(path.join(workspace.path, "tracked.txt"), "committed worker change\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace.path });
    execFileSync("git", ["commit", "-qm", "worker commit"], { cwd: workspace.path });
    fs.writeFileSync(path.join(workspace.path, "untracked.txt"), "untracked worker change\n");
    const patch = workspace.capturePatch();
    assert(patch.includes("committed worker change"), "capture includes committed worker changes");
    assert(patch.includes("untracked worker change"), "capture includes untracked worker changes");
    assert(!patch.includes(".pi-ig-worktree.json"), "capture excludes ownership marker");
  } finally {
    workspace.cleanup();
  }

  console.log("✓ Telemetry, bounded logging, retention safety, worker environment, and complete patch capture");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
