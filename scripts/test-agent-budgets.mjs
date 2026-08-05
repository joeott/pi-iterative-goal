#!/usr/bin/env node
/** Offline regression coverage for hard subagent turn/token/cost budgets. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { PiSubprocessAgentPool, createAgentTask, readOsProcessIdentity } = await import("../dist/agents/pool.js");
const { dispatchAgentTask } = await import("../dist/agents/run-pool.js");
const { requireModelRoute } = await import("../dist/domain/model-roster.js");
const { CapabilityBroker } = await import("../dist/capabilities/broker.js");
const { PolicyEngine } = await import("../dist/policy/engine.js");
const { loadModelInvocations } = await import("../dist/model-telemetry.js");

function makeGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-agent-budget-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "budget-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Budget Test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
  return repo;
}

function makeManualSpawn({ pid = null } = {}) {
  const pending = [];
  const spawnImpl = (command, args, options) => {
    const proc = new EventEmitter();
    if (pid !== null) proc.pid = pid;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.signals = [];
    proc.kill = (signal) => {
      proc.signals.push(signal);
      return true;
    };
    proc.emitAssistant = ({
      provider,
      model,
      input,
      output,
      cacheRead = 0,
      cacheWrite = 0,
      cost,
      stopReason = "stop",
      responseModel,
      omitResponseModel = false,
      toolCallCount = 0,
    }, newline = true) => {
      const usage = { input, output, cacheRead, cacheWrite };
      if (cost !== undefined) usage.cost = { total: cost };
      const event = {
        type: "message_end",
        message: {
          role: "assistant",
          provider,
          model,
          stopReason,
          content: [
            { type: "text", text: "budget fixture" },
            ...Array.from({ length: toolCallCount }, (_, index) => ({
              type: "toolCall",
              id: `call-${index + 1}`,
              name: "read",
              arguments: { path: "seed.txt" },
            })),
          ],
          usage,
          ...(omitResponseModel ? {} : { responseModel: responseModel ?? model }),
        },
      };
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}${newline ? "\n" : ""}`));
    };
    proc.emitToolResult = (isError) => {
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: isError ? "failed" : "ok" }],
          isError,
        },
      })}\n`));
    };
    proc.emitRaw = (event) => proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
    proc.finish = (code = 0) => proc.emit("close", code);
    pending.push({ command, args, options, proc });
    return proc;
  };
  spawnImpl.pending = pending;
  return spawnImpl;
}

function task(id, budget, overrides = {}) {
  return createAgentTask(overrides.role ?? "Scout", `budget fixture ${id}`, {
    id,
    workspace: overrides.workspace ?? "read_only_snapshot",
    allowedPaths: overrides.allowedPaths ?? [],
    modelProfile: overrides.modelProfile,
    budget,
  });
}

async function runSingle(repo, agentTask, message, { newline = true } = {}) {
  const spawnImpl = makeManualSpawn();
  const pool = new PiSubprocessAgentPool(repo, { spawnImpl, killGraceMs: 10 });
  const resultPromise = pool.submit(agentTask);
  assert.equal(spawnImpl.pending.length, 1, "task reaches the fake subprocess");
  const child = spawnImpl.pending[0].proc;
  const route = requireModelRoute(agentTask.modelProfile);
  child.emitAssistant({ provider: route.provider, model: route.model, ...message }, newline);
  return { pool, child, resultPromise };
}

const repo = makeGitRepo();
try {
  // A tool-use response at maxTurns would necessarily cause another provider
  // call. Stop it immediately, escalate exactly TERM -> KILL, and retain the
  // writer scope until the child has actually closed.
  const turnsTask = task("budget-turns", {
    maxTurns: 1,
    maxTokens: 1_000,
    timeoutMs: 10_000,
  }, { role: "Implementer", workspace: "isolated_worktree", allowedPaths: ["src/budget.ts"] });
  const turns = await runSingle(repo, turnsTask, {
    input: 10,
    output: 5,
    cost: 0.001,
    stopReason: "toolUse",
  });
  assert.deepEqual(turns.child.signals, ["SIGTERM"], "turn cap sends immediate TERM to the owned child");
  assert.equal(turns.pool.getActiveWriteScopes().has(turnsTask.id), true, "writer scope remains held after TERM");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(turns.child.signals, ["SIGTERM", "SIGKILL"], "turn cap escalates to KILL after the bounded grace period");
  assert.equal(turns.pool.getActiveWriteScopes().has(turnsTask.id), true, "writer scope remains held through KILL");
  turns.child.finish(143);
  const turnsResult = await turns.resultPromise;
  assert.equal(turnsResult.ok, false);
  assert.deepEqual(turnsResult.budgetExhausted && {
    reason: turnsResult.budgetExhausted.reason,
    limit: turnsResult.budgetExhausted.limit,
    maximum: turnsResult.budgetExhausted.maximum,
    observed: turnsResult.budgetExhausted.observed,
  }, { reason: "budget_exhausted", limit: "maxTurns", maximum: 1, observed: 1 });
  assert.match(turnsResult.stderr, /budget_exhausted:maxTurns/);
  assert.equal(turns.pool.getActiveWriteScopes().has(turnsTask.id), false, "writer scope releases only on close");

  const tokensTask = task("budget-tokens", { maxTurns: 4, maxTokens: 100, timeoutMs: 10_000 });
  const tokenSpawn = makeManualSpawn();
  const tokenPool = new PiSubprocessAgentPool(repo, { spawnImpl: tokenSpawn, killGraceMs: 10 });
  const tokenPromise = tokenPool.submit(tokensTask);
  const tokenChild = tokenSpawn.pending[0].proc;
  tokenChild.emitRaw({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    },
  });
  tokenChild.emitAssistant({ input: 80, output: 21, cost: 0.001 });
  const tokens = { child: tokenChild, resultPromise: tokenPromise };
  assert.deepEqual(tokens.child.signals, ["SIGTERM"]);
  tokens.child.finish(143);
  const tokensResult = await tokens.resultPromise;
  assert.equal(tokensResult.budgetExhausted?.limit, "maxTokens");
  assert.equal(tokensResult.budgetExhausted?.observed, 101);
  assert.equal(tokensResult.usage.input + tokensResult.usage.output, 101, "streaming usage snapshots are not double-counted");

  // No catalog route currently has a complete, source-backed price snapshot.
  // Unknown is not free: reject maxCost before worktree creation or spawn.
  const unpricedCostTask = task("budget-unpriced-cost", {
    maxTurns: 4,
    maxTokens: 1_000,
    maxCost: 0.01,
    timeoutMs: 10_000,
  });
  const unpricedSpawn = makeManualSpawn();
  const unpricedPool = new PiSubprocessAgentPool(repo, { spawnImpl: unpricedSpawn });
  const unpricedCostResult = await unpricedPool.submit(unpricedCostTask);
  assert.equal(unpricedCostResult.ok, false);
  assert.match(unpricedCostResult.stderr, /cannot enforce maxCost: verified pricing is unavailable/);
  assert.equal(unpricedSpawn.pending.length, 0, "unpriced USD budgets fail before subprocess admission");

  // Exact limits are valid for a terminal response, including a final JSON
  // event without a trailing newline. The close handler must account for it.
  const exactTask = task("budget-exact-final", {
    maxTurns: 1,
    maxTokens: 15,
    timeoutMs: 10_000,
  });
  const exact = await runSingle(repo, exactTask, { input: 10, output: 5, cost: 0.001 }, { newline: false });
  exact.child.finish(0);
  const exactResult = await exact.resultPromise;
  assert.equal(exactResult.ok, true, "terminal response exactly at turn/token limits is admitted");
  assert.equal(exactResult.usage.turns, 1);
  assert.equal(exactResult.usage.input + exactResult.usage.output, 15);
  assert.equal(exactResult.responseModel, "gpt-oss-120b");

  const missingIdentityTask = task("budget-missing-identity", {
    maxTurns: 1,
    maxTokens: 15,
    timeoutMs: 10_000,
  });
  const missingIdentity = await runSingle(
    repo,
    missingIdentityTask,
    { input: 10, output: 5, omitResponseModel: true },
  );
  missingIdentity.child.finish(0);
  const missingIdentityResult = await missingIdentity.resultPromise;
  assert.equal(missingIdentityResult.ok, false, "the exported pool fails closed on missing response identity");
  assert.equal(missingIdentityResult.responseModel, null);
  assert.equal(missingIdentityResult.responseIdentityError, "response_model_identity_missing");
  assert.match(missingIdentityResult.stderr, /response_model_identity_missing/);

  const stickyIdentityTask = task("budget-sticky-identity", {
    maxTurns: 2,
    maxTokens: 100,
    timeoutMs: 10_000,
  });
  const stickySpawn = makeManualSpawn();
  const stickyPool = new PiSubprocessAgentPool(repo, { spawnImpl: stickySpawn });
  const stickyPromise = stickyPool.submit(stickyIdentityTask);
  const stickyChild = stickySpawn.pending[0].proc;
  const stickyRoute = requireModelRoute(stickyIdentityTask.modelProfile);
  stickyChild.emitAssistant({
    provider: stickyRoute.provider,
    model: stickyRoute.model,
    input: 10,
    output: 5,
    responseModel: "wrong-model",
  });
  stickyChild.emitAssistant({
    provider: stickyRoute.provider,
    model: stickyRoute.model,
    input: 10,
    output: 5,
    responseModel: stickyRoute.model,
  });
  stickyChild.finish(0);
  const stickyIdentityResult = await stickyPromise;
  assert.equal(stickyIdentityResult.ok, false, "a later valid turn cannot erase an earlier identity violation");
  assert.equal(stickyIdentityResult.responseModel, null);
  assert.equal(stickyIdentityResult.responseIdentityError, "response_model_mismatch");

  // Preserve the exact provider response identity (including Fireworks fast's
  // fixed backing-model value) and derive tool counters from finalized Pi JSON
  // messages. Downstream policy owns mapping, not this parser.
  const metadataTask = task("budget-result-metadata", {
    maxTurns: 4,
    maxTokens: 1_000,
    timeoutMs: 10_000,
  }, { modelProfile: "fireworks_glm_5_2_fast" });
  const metadata = await runSingle(repo, metadataTask, {
    input: 10,
    output: 5,
    cost: 0.001,
    responseModel: "accounts/fireworks/models/glm-5p2",
    toolCallCount: 2,
  });
  metadata.child.emitToolResult(false);
  metadata.child.emitToolResult(true);
  metadata.child.finish(0);
  const metadataResult = await metadata.resultPromise;
  assert.equal(metadataResult.ok, true);
  assert.equal(metadataResult.responseModel, "accounts/fireworks/models/glm-5p2");
  assert.equal(metadataResult.toolCallCount, 2);
  assert.equal(metadataResult.toolErrorCount, 1);

  const framedOverTask = task("budget-unframed-over", { maxTurns: 4, maxTokens: 14, timeoutMs: 10_000 });
  const framedOver = await runSingle(repo, framedOverTask, { input: 10, output: 5, cost: 0.001 }, { newline: false });
  framedOver.child.finish(0);
  const framedOverResult = await framedOver.resultPromise;
  assert.equal(framedOverResult.ok, false, "unterminated final JSON cannot evade budget accounting");
  assert.equal(framedOverResult.budgetExhausted?.limit, "maxTokens");

  const missingTurnTask = task("budget-no-measured-turn", { maxTurns: 4, maxTokens: 100, timeoutMs: 10_000 });
  const missingTurnSpawn = makeManualSpawn();
  const missingTurnPool = new PiSubprocessAgentPool(repo, { spawnImpl: missingTurnSpawn });
  const missingTurnPromise = missingTurnPool.submit(missingTurnTask);
  missingTurnSpawn.pending[0].proc.finish(0);
  const missingTurnResult = await missingTurnPromise;
  assert.equal(missingTurnResult.ok, false, "zero-exit JSON worker without a measured assistant turn fails closed");
  assert.equal(missingTurnResult.budgetExhausted?.limit, "maxTokens");
  assert.equal(missingTurnResult.budgetExhausted?.observed, null);

  const timeoutTask = task("budget-timeout", { maxTurns: 4, maxTokens: 100, timeoutMs: 5 });
  const timeoutSpawn = makeManualSpawn();
  const timeoutPool = new PiSubprocessAgentPool(repo, { spawnImpl: timeoutSpawn, killGraceMs: 5 });
  const timeoutPromise = timeoutPool.submit(timeoutTask);
  const timeoutChild = timeoutSpawn.pending[0].proc;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(timeoutChild.signals, ["SIGTERM", "SIGKILL"], "wall-clock budget escalates TERM to KILL");
  timeoutChild.finish(143);
  const timeoutResult = await timeoutPromise;
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.budgetExhausted?.limit, "timeoutMs");
  assert.ok((timeoutResult.budgetExhausted?.observed ?? 0) >= 5);

  // Detached process groups are authorized with a kernel birth token at spawn
  // and re-authenticated before both TERM and delayed KILL. A reused numeric
  // PID/PGID must never receive an escalation intended for the old worker.
  const ownedPid = 47_001;
  const originalIdentity = {
    pid: ownedPid,
    parentPid: process.pid,
    processGroupId: ownedPid,
    startToken: "test-boot:100",
  };
  let observedIdentity = originalIdentity;
  const ownedSignals = [];
  const ownedSpawn = makeManualSpawn({ pid: ownedPid });
  const ownedPool = new PiSubprocessAgentPool(repo, {
    spawnImpl: ownedSpawn,
    killGraceMs: 5,
    readProcessIdentity: () => observedIdentity,
    signalProcessGroup: (processGroupId, signal) => ownedSignals.push({ processGroupId, signal }),
  });
  const ownedTask = task("budget-owned-group", { maxTurns: 4, maxTokens: 100, timeoutMs: 10_000 });
  const ownedPromise = ownedPool.submit(ownedTask);
  assert.equal(await ownedPool.cancel(ownedTask.id), "running");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ownedSignals, [
    { processGroupId: ownedPid, signal: "SIGTERM" },
    { processGroupId: ownedPid, signal: "SIGKILL" },
  ], "unchanged birth identity authorizes the bounded group TERM→KILL sequence");
  assert.deepEqual(ownedSpawn.pending[0].proc.signals, [], "real-PID path never falls back to raw ChildProcess.kill");
  ownedSpawn.pending[0].proc.finish(143);
  await ownedPromise;

  const stalePid = 47_002;
  let staleIdentity = {
    pid: stalePid,
    parentPid: process.pid,
    processGroupId: stalePid,
    startToken: "test-boot:200",
  };
  const staleSignals = [];
  const staleSpawn = makeManualSpawn({ pid: stalePid });
  const stalePool = new PiSubprocessAgentPool(repo, {
    spawnImpl: staleSpawn,
    killGraceMs: 5,
    readProcessIdentity: () => staleIdentity,
    signalProcessGroup: (processGroupId, signal) => staleSignals.push({ processGroupId, signal }),
  });
  const staleTask = task("budget-stale-group", { maxTurns: 4, maxTokens: 100, timeoutMs: 10_000 });
  const stalePromise = stalePool.submit(staleTask);
  staleIdentity = { ...staleIdentity, startToken: "test-boot:201" };
  assert.equal(await stalePool.cancel(staleTask.id), "running");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(staleSignals, [], "reused PID/PGID with a different birth token is never signalled");
  assert.deepEqual(staleSpawn.pending[0].proc.signals, [], "stale real PID never falls back to a raw PID signal");
  staleSpawn.pending[0].proc.finish(143);
  await stalePromise;

  if (process.platform === "linux") {
    // Inside a PID namespace (bwrap trusted-verification sandbox) /proc is
    // constrained: /proc/self/stat reports ppid 0 and the reader fails
    // closed by design. The host validate step covers the reader; skip here.
    let pidNamespaceConstrained = false;
    try {
      const stat = fs.readFileSync("/proc/self/stat", "utf8").trim();
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      pidNamespaceConstrained = Number(fields[1]) === 0;
    } catch { pidNamespaceConstrained = true; }
    if (pidNamespaceConstrained) {
      console.log("  (Linux identity reader assertions skipped: PID-namespace-constrained /proc)");
    } else {
      const selfIdentity = readOsProcessIdentity(process.pid);
      assert.equal(selfIdentity?.pid, process.pid, "Linux identity reader resolves the current process");
      assert.ok(selfIdentity?.startToken, "Linux identity reader returns a non-empty birth token");
    }
  } else if (process.platform === "darwin") {
    let psAllowed = true;
    try {
      execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pid="], { stdio: "ignore" });
    } catch {
      psAllowed = false;
    }
    const selfIdentity = readOsProcessIdentity(process.pid);
    if (psAllowed) {
      assert.equal(selfIdentity?.pid, process.pid, "Darwin identity reader resolves the current process when ps is allowed");
      assert.ok(selfIdentity?.startToken, "Darwin identity reader returns a non-empty birth token");
    } else {
      assert.equal(selfIdentity, null, "Darwin identity reader fails closed when the OS denies ps inspection");
    }
  }

  const abortTask = task("budget-abort", { maxTurns: 4, maxTokens: 100, timeoutMs: 10_000 });
  const abortSpawn = makeManualSpawn();
  const abortPool = new PiSubprocessAgentPool(repo, { spawnImpl: abortSpawn, killGraceMs: 5 });
  const controller = new AbortController();
  const abortPromise = abortPool.submit(abortTask, controller.signal);
  const abortChild = abortSpawn.pending[0].proc;
  controller.abort();
  assert.deepEqual(abortChild.signals, ["SIGTERM"]);
  assert.equal(abortPool.wasCancelled(abortTask.id), true);
  abortChild.finish(0);
  const abortResult = await abortPromise;
  assert.equal(abortResult.ok, false, "abort cannot be reported as successful even if the child exits zero");
  assert.match(abortResult.stderr, /cancelled_by_abort_signal/);

  const preAbortSpawn = makeManualSpawn();
  const preAbortPool = new PiSubprocessAgentPool(repo, { spawnImpl: preAbortSpawn });
  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortResult = await preAbortPool.submit(
    task("budget-pre-abort", { maxTurns: 4, maxTokens: 100, timeoutMs: 10_000 }),
    preAborted.signal,
  );
  assert.equal(preAbortResult.ok, false);
  assert.equal(preAbortSpawn.pending.length, 0, "pre-aborted work never reaches subprocess admission");

  const invalidSpawn = makeManualSpawn();
  const invalidPool = new PiSubprocessAgentPool(repo, { spawnImpl: invalidSpawn });
  const invalidResult = await invalidPool.submit(task("budget-invalid", { maxTurns: 0, maxTokens: 10, timeoutMs: 10_000 }));
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.stderr, /invalid maxTurns budget/);
  assert.equal(invalidSpawn.pending.length, 0, "invalid budgets fail before subprocess admission");
  assert.equal(invalidResult.responseModel, null);
  assert.equal(invalidResult.toolCallCount, 0);
  assert.equal(invalidResult.toolErrorCount, 0);

  // The dispatch/ledger/telemetry boundary preserves the kernel stop as a
  // first-class terminal classification rather than a generic provider error.
  const started = [];
  const finished = [];
  const stateManager = {
    getState() {
      return {
        runId: "budget-dispatch-run",
        cycle: 1,
        phase: "implement",
        lock: { activePhaseId: "budget-dispatch-run/c1/implement/a1" },
      };
    },
    recordSubagentStarted(record) { started.push(record); },
    recordSubagentFinished(taskId, finish) { finished.push({ taskId, ...finish }); },
  };
  const classified = await dispatchAgentTask({
    pool: {
      async submit() { return tokensResult; },
      async map() { throw new Error("not used"); },
      async cancel() { return "unknown"; },
      wasCancelled() { return false; },
    },
    broker: new CapabilityBroker(new PolicyEngine({ repoRoot: repo })),
    stateManager,
    runId: "budget-dispatch-run",
    batchId: "budget-dispatch-batch",
    mode: "single",
    backend: "pi-subprocess",
    detectedBackend: "none",
    cwd: repo,
  }, tokensTask);
  assert.equal(classified.ok, false);
  assert.equal(classified.status, "failed");
  assert.equal(started.length, 1);
  assert.equal(finished.at(-1).status, "failed");
  const invocation = loadModelInvocations(repo, "budget-dispatch-run").at(-1);
  assert.equal(invocation?.termination, "budget_exhausted");
  assert.equal(invocation?.errorCode, "budget_exhausted_maxTokens");

  console.log("✓ hard agent budgets enforce turns/tokens/time, reject unpriced USD limits, preserve identity, and classify telemetry");
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
