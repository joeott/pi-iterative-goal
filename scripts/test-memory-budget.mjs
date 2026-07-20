#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  effectiveSwarmConcurrency,
  resolveAgentMemoryBudget,
} from "../dist/agents/memory-budget.js";
import { buildWorkerEnvironment } from "../dist/agents/pool.js";

const metrics = { totalMiB: 128 * 1024, availableMiB: 100 * 1024 };
const cmux = resolveAgentMemoryBudget({
  CMUX_MEMORY_PLAN_VERSION: "1",
  CMUX_AGENT_OLD_SPACE_MIB: "1536",
  CMUX_SWARM_MAX_CONCURRENCY: "3",
  CMUX_MEMORY_AVAILABLE_MIB: "49152",
}, metrics);
assert.equal(cmux.source, "cmux");
assert.equal(cmux.oldSpaceMiB, 1536);
assert.equal(cmux.maxConcurrency, 3);
assert.equal(effectiveSwarmConcurrency(8, {
  CMUX_MEMORY_PLAN_VERSION: "1",
  CMUX_AGENT_OLD_SPACE_MIB: "1536",
  CMUX_SWARM_MAX_CONCURRENCY: "3",
}, metrics), 3);

assert.throws(
  () => resolveAgentMemoryBudget({ CMUX_AGENT_OLD_SPACE_MIB: "1536" }, metrics),
  /incomplete cmux memory contract/,
);
assert.throws(
  () => resolveAgentMemoryBudget({
    CMUX_MEMORY_PLAN_VERSION: "1",
    CMUX_AGENT_OLD_SPACE_MIB: "1536 --require evil.js",
    CMUX_SWARM_MAX_CONCURRENCY: "3",
  }, metrics),
  /CMUX_AGENT_OLD_SPACE_MIB/,
);

const worker = buildWorkerEnvironment({
  PATH: "/usr/bin",
  NODE_OPTIONS: "--max-old-space-size=49152 --max-semi-space-size=8192 --require /tmp/evil.js",
  CMUX_MEMORY_PLAN_VERSION: "1",
  CMUX_AGENT_OLD_SPACE_MIB: "1536",
  CMUX_SWARM_MAX_CONCURRENCY: "3",
});
assert.equal(worker.NODE_OPTIONS, "--max-old-space-size=1536");
assert.equal(worker.CMUX_SWARM_MAX_CONCURRENCY, "3");
assert.equal(worker.NODE_OPTIONS.includes("semi-space"), false);
assert.equal(worker.NODE_OPTIONS.includes("require"), false);

const local = resolveAgentMemoryBudget({}, { totalMiB: 128 * 1024, availableMiB: 20 * 1024 });
assert.equal(local.source, "local");
assert.equal(local.maxConcurrency, 1);
assert.equal(local.oldSpaceMiB, 2048);

console.log("memory-budget: PASS (cmux contract, safe NODE_OPTIONS, pressure concurrency)");
