import { deepStrictEqual, ok, strictEqual as eq } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-model-failover-"));
const originalCwd = process.cwd();
process.chdir(testRoot);

try {
  const {
    findFirstHealthyFallback,
    loadConfiguredModel,
    startPhaseAttempt,
  } = await import("../dist/kernel/workflow-engine.js");

  const primary = { provider: "zai", model: "glm-5.2" };
  const fireworks = { provider: "fireworks", model: "accounts/fireworks/models/glm-5p2" };
  const kimi = { provider: "openrouter", model: "moonshotai/kimi-k3" };

  function stateWith(overrides = {}) {
    return {
      runId: "ig-model-failover-test",
      cycle: 3,
      phase: "plan",
      status: "running",
      config: {
        primaryModel: primary,
        fallbackModels: [fireworks, kimi],
        modelHealth: {},
        ...(overrides.config ?? {}),
      },
      phaseAttempts: [],
      errors: [],
      lock: {
        activeRunId: "ig-model-failover-test",
        activePhaseId: null,
        phaseLeaseOwner: "",
        phaseStartedAt: new Date().toISOString(),
        phaseStatus: "running",
        queuedPhaseIds: [],
      },
      ...overrides,
    };
  }

  function managerFor(state, { acquire = true } = {}) {
    const calls = { acquired: [], released: [], started: [], events: [], errors: [], persisted: 0 };
    return {
      calls,
      acquireLock(runId, phaseAttemptId) {
        calls.acquired.push([runId, phaseAttemptId]);
        if (!acquire) return false;
        state.lock.activeRunId = runId;
        state.lock.activePhaseId = phaseAttemptId;
        state.lock.phaseLeaseOwner = phaseAttemptId;
        state.lock.phaseStatus = "running";
        return true;
      },
      releaseLock(runId, phaseAttemptId) {
        calls.released.push([runId, phaseAttemptId]);
        if (state.lock.phaseLeaseOwner === phaseAttemptId) {
          state.lock.activePhaseId = null;
          state.lock.phaseLeaseOwner = "";
        }
      },
      startPhaseAttempt(attempt) {
        calls.started.push(attempt);
        state.phaseAttempts.push(attempt);
      },
      recordPhaseEvent(event) { calls.events.push(event); },
      recordError(error) { calls.errors.push(error); state.errors.push(error); },
      setStatus(status) { state.status = status; },
      persistAll() { calls.persisted += 1; },
    };
  }

  function contextWith(find) {
    return { modelRegistry: { find } };
  }

  // Cooldown skips the primary; a thrown registry load continues in exact
  // configured order and starts only after the next endpoint loads.
  {
    const state = stateWith();
    state.config.modelHealth["zai/glm-5.2"] = {
      provider: "zai",
      model: "glm-5.2",
      lastStatus: "unavailable",
      lastCheckedAt: new Date().toISOString(),
      error: "rate limited",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const manager = managerFor(state);
    const registryCalls = [];
    const setCalls = [];
    const ctx = contextWith((provider, model) => {
      registryCalls.push(`${provider}/${model}`);
      return { provider, model };
    });
    const pi = {
      async setModel(model) {
        setCalls.push(`${model.provider}/${model.model}`);
        if (model.provider === "fireworks") throw new Error("provider registry rejected selection");
        return true;
      },
    };

    const result = await startPhaseAttempt(state, manager, "plan", null, pi, ctx);
    eq(result.started, true);
    if (!result.started) throw new Error("expected a started result");
    deepStrictEqual(result.model, kimi);
    deepStrictEqual(registryCalls, [
      "fireworks/accounts/fireworks/models/glm-5p2",
      "openrouter/moonshotai/kimi-k3",
    ]);
    deepStrictEqual(setCalls, registryCalls);
    eq(result.fallbackChain.length, 2);
    ok(result.fallbackChain[0].reason.includes("health cooldown"));
    ok(result.fallbackChain[1].reason.includes("registry load failed"));
    eq(manager.calls.acquired.length, 1);
    eq(manager.calls.started.length, 1);
    eq(state.phaseAttempts[0].modelProvider, "openrouter");
    eq(state.phaseAttempts[0].modelModel, "moonshotai/kimi-k3");
  }

  // An inexact/unlisted selector is rejected before registry lookup.
  {
    let finds = 0;
    let sets = 0;
    const loaded = await loadConfiguredModel(
      contextWith(() => { finds += 1; return {}; }),
      { setModel: async () => { sets += 1; return true; } },
      "openrouter",
      "moonshotai/kimi-k3:latest",
    );
    eq(loaded.loaded, false);
    eq(finds, 0);
    eq(sets, 0);
  }

  // No exact endpoint load means provider_unavailable, no attempt, no new
  // lock, and any previous lease is released before persistence.
  {
    const state = stateWith({
      config: {
        primaryModel: { provider: "unlisted", model: "mystery/latest" },
        fallbackModels: [primary, fireworks],
        modelHealth: {},
      },
    });
    state.lock.activePhaseId = "ig-model-failover-test/c3/research/a1";
    state.lock.phaseLeaseOwner = state.lock.activePhaseId;
    const manager = managerFor(state);
    const registryCalls = [];
    const ctx = contextWith((provider, model) => {
      registryCalls.push(`${provider}/${model}`);
      return null;
    });
    const result = await startPhaseAttempt(state, manager, "plan", null, { setModel: async () => true }, ctx);

    eq(result.started, false);
    if (result.started) throw new Error("expected a stopped result");
    eq(result.reason, "provider_unavailable");
    deepStrictEqual(registryCalls, ["zai/glm-5.2", "fireworks/accounts/fireworks/models/glm-5p2"]);
    eq(state.status, "provider_unavailable");
    eq(state.lock.activePhaseId, null);
    eq(state.lock.phaseStatus, "paused");
    eq(manager.calls.acquired.length, 0);
    eq(manager.calls.started.length, 0);
    eq(manager.calls.released.length, 1);
    eq(manager.calls.errors.length, 1);
  }

  // A loadable endpoint is still not allowed to create an attempt when lock
  // acquisition fails. Callers use the result to suppress the phase prompt.
  {
    const state = stateWith({ config: { primaryModel: kimi, fallbackModels: [], modelHealth: {} } });
    const manager = managerFor(state, { acquire: false });
    const result = await startPhaseAttempt(
      state,
      manager,
      "plan",
      null,
      { setModel: async () => true },
      contextWith((provider, model) => ({ provider, model })),
    );
    eq(result.started, false);
    if (result.started) throw new Error("expected a stopped result");
    eq(result.reason, "lock_unavailable");
    eq(manager.calls.started.length, 0);
    eq(state.status, "running");
  }

  // Fallback discovery preserves configured order, excludes already-tried
  // routes, ignores inexact entries, and respects endpoint cooldown.
  {
    const state = stateWith({
      config: {
        primaryModel: primary,
        fallbackModels: [
          { provider: "openrouter", model: "moonshotai/kimi-k3:latest" },
          fireworks,
          kimi,
        ],
        modelHealth: {
          "fireworks/accounts/fireworks/models/glm-5p2": {
            provider: "fireworks",
            model: "accounts/fireworks/models/glm-5p2",
            lastStatus: "unavailable",
            lastCheckedAt: new Date().toISOString(),
            error: "cooldown",
            cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
    });
    deepStrictEqual(findFirstHealthyFallback(state), kimi);
    eq(findFirstHealthyFallback(state, [kimi]), null);
  }

  console.log("✓ Exact model failover: ordered cooldown-aware loading, fail-closed no-lock behavior, and inexact selector rejection");
} finally {
  process.chdir(originalCwd);
  fs.rmSync(testRoot, { recursive: true, force: true });
}
