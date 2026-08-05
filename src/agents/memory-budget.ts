import * as os from "node:os";

const MIB = 1024 * 1024;
export const LOCAL_MEMORY_PLAN_VERSION = 1;
export const MIN_AGENT_OLD_SPACE_MIB = 1024;
export const MAX_AGENT_OLD_SPACE_MIB = 8192;
export const LOCAL_DEFAULT_OLD_SPACE_MIB = 2048;
export const LOCAL_SYSTEM_RESERVE_MIB = 16 * 1024;
export const LOCAL_PER_WORKER_AVAILABLE_MIB = 3 * 1024;

export interface AgentMemoryMetrics {
  totalMiB: number;
  availableMiB: number;
}

export interface AgentMemoryBudget {
  schema: "pi-iterative-goal.agent-memory-budget.v1";
  source: "cmux" | "local";
  planVersion: number;
  oldSpaceMiB: number;
  maxConcurrency: number;
  availableMiB: number;
  nodeOptions: string;
}

function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function optionalEnvironmentInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  const value = env[key];
  if (value === undefined || value === "") return null;
  return safeInteger(value, key, minimum, maximum);
}

export function localAgentMemoryMetrics(): AgentMemoryMetrics {
  return {
    totalMiB: Math.floor(os.totalmem() / MIB),
    availableMiB: Math.floor(os.freemem() / MIB),
  };
}

export function resolveAgentMemoryBudget(
  env: NodeJS.ProcessEnv = process.env,
  metrics: AgentMemoryMetrics = localAgentMemoryMetrics(),
): AgentMemoryBudget {
  const cmuxOldSpace = optionalEnvironmentInteger(
    env,
    "CMUX_AGENT_OLD_SPACE_MIB",
    MIN_AGENT_OLD_SPACE_MIB,
    MAX_AGENT_OLD_SPACE_MIB,
  );
  const cmuxConcurrency = optionalEnvironmentInteger(env, "CMUX_SWARM_MAX_CONCURRENCY", 1, 8);
  const cmuxPlanVersion = optionalEnvironmentInteger(env, "CMUX_MEMORY_PLAN_VERSION", 1, 1_000_000);
  const anyCmuxField = cmuxOldSpace !== null || cmuxConcurrency !== null || cmuxPlanVersion !== null;
  const allCmuxFields = cmuxOldSpace !== null && cmuxConcurrency !== null && cmuxPlanVersion !== null;
  if (anyCmuxField && !allCmuxFields) {
    throw new Error("incomplete cmux memory contract: plan version, old-space, and concurrency are all required");
  }

  if (allCmuxFields) {
    return {
      schema: "pi-iterative-goal.agent-memory-budget.v1",
      source: "cmux",
      planVersion: cmuxPlanVersion,
      oldSpaceMiB: cmuxOldSpace,
      maxConcurrency: cmuxConcurrency,
      availableMiB: optionalEnvironmentInteger(env, "CMUX_MEMORY_AVAILABLE_MIB", 0, Number.MAX_SAFE_INTEGER)
        ?? metrics.availableMiB,
      nodeOptions: `--max-old-space-size=${cmuxOldSpace}`,
    };
  }

  const headroomMiB = Math.max(0, metrics.availableMiB - LOCAL_SYSTEM_RESERVE_MIB);
  const localConcurrency = Math.max(1, Math.min(8, Math.floor(headroomMiB / LOCAL_PER_WORKER_AVAILABLE_MIB)));
  const pressureShareMiB = Math.floor(headroomMiB / localConcurrency);
  const oldSpaceMiB = Math.max(
    MIN_AGENT_OLD_SPACE_MIB,
    Math.min(MAX_AGENT_OLD_SPACE_MIB, LOCAL_DEFAULT_OLD_SPACE_MIB, pressureShareMiB || MIN_AGENT_OLD_SPACE_MIB),
  );
  return {
    schema: "pi-iterative-goal.agent-memory-budget.v1",
    source: "local",
    planVersion: LOCAL_MEMORY_PLAN_VERSION,
    oldSpaceMiB,
    maxConcurrency: localConcurrency,
    availableMiB: metrics.availableMiB,
    nodeOptions: `--max-old-space-size=${oldSpaceMiB}`,
  };
}

export function effectiveSwarmConcurrency(
  requested: number,
  env: NodeJS.ProcessEnv = process.env,
  metrics?: AgentMemoryMetrics,
): number {
  const bounded = safeInteger(Math.floor(requested), "requested swarm concurrency", 1, 8);
  return Math.min(bounded, resolveAgentMemoryBudget(env, metrics).maxConcurrency);
}
