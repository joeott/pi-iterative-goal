#!/usr/bin/env node
/** Offline regression coverage for hard subagent turn/token/cost budgets. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { PiSubprocessAgentPool, createAgentTask } = await import("../dist/agents/pool.js");
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

function makeManualSpawn() {
  const pending = [];
  const spawnImpl = (command, args, options) => {
    const proc = new EventEmitter();
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
          ...(responseModel === undefined ? {} : { responseModel }),
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
    maxCost: 1,
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

  const costTask = task("budget-cost", { maxTurns: 4, maxTokens: 1_000, maxCost: 0.01, timeoutMs: 10_000 });
  const cost = await runSingle(repo, costTask, { input: 10, output: 5, cost: 0.011 });
  assert.deepEqual(cost.child.signals, ["SIGTERM"]);
  cost.child.finish(143);
  const costResult = await cost.resultPromise;
  assert.equal(costResult.budgetExhausted?.limit, "maxCost");
  assert.equal(costResult.budgetExhausted?.observed, 0.011);

  // Missing required provider measurements fail closed instead of silently
  // converting unavailable cost into zero.
  const missingCostTask = task("budget-missing-cost", {
    maxTurns: 4,
    maxTokens: 1_000,
    maxCost: 0.01,
    timeoutMs: 10_000,
  });
  const missingCost = await runSingle(repo, missingCostTask, { input: 10, output: 5 });
  missingCost.child.finish(143);
  const missingCostResult = await missingCost.resultPromise;
  assert.equal(missingCostResult.budgetExhausted?.limit, "maxCost");
  assert.equal(missingCostResult.budgetExhausted?.observed, null);

  // Exact limits are valid for a terminal response, including a final JSON
  // event without a trailing newline. The close handler must account for it.
  const exactTask = task("budget-exact-final", {
    maxTurns: 1,
    maxTokens: 15,
    maxCost: 0.001,
    timeoutMs: 10_000,
  });
  const exact = await runSingle(repo, exactTask, { input: 10, output: 5, cost: 0.001 }, { newline: false });
  exact.child.finish(0);
  const exactResult = await exact.resultPromise;
  assert.equal(exactResult.ok, true, "terminal response exactly at all limits is admitted");
  assert.equal(exactResult.usage.turns, 1);
  assert.equal(exactResult.usage.input + exactResult.usage.output, 15);
  assert.equal(exactResult.responseModel, "gpt-oss-120b", "native Pi identity normalizes when responseModel is absent");

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
      async submit() { return costResult; },
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
  }, costTask);
  assert.equal(classified.ok, false);
  assert.equal(classified.status, "failed");
  assert.equal(started.length, 1);
  assert.equal(finished.at(-1).status, "failed");
  const invocation = loadModelInvocations(repo, "budget-dispatch-run").at(-1);
  assert.equal(invocation?.termination, "budget_exhausted");
  assert.equal(invocation?.errorCode, "budget_exhausted_maxCost");

  console.log("✓ hard agent budgets enforce turns/tokens/cost/time, cancellation, exact TERM→KILL ownership, close framing, and telemetry classification");
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
