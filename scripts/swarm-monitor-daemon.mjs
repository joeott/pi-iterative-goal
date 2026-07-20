#!/usr/bin/env node
/** Run the model-free monitor tracer until its exact ownership marker changes. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTraceConfig, traceOnce } from "./swarm-monitor-trace.mjs";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function readOwner(ownerFile) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  } catch {
    return null;
  }
}

function stillOwned(config) {
  const owner = readOwner(config.ownerFile);
  return owner?.ownerToken === config.ownerToken
    && owner?.runId === config.runId
    && path.resolve(owner?.repo ?? "") === config.repo;
}

export async function runDaemon(input) {
  const config = normalizeTraceConfig(input);
  if (!config.ownerFile || !config.ownerToken) throw new Error("owner-file and owner-token are required");
  let stopping = false;
  let wake = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping && stillOwned(config)) {
      // Tick 1 lands after one full trace interval. Consequently tick 4 is a
      // real 24-minute boundary at the production 360/1440 cadence, not the
      // 18-minute boundary an eager t=0 sample would create.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, config.traceSeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
      if (stopping || !stillOwned(config)) break;
      traceOnce({ ...config, now: new Date() });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runDaemon({
    repo: args.repo,
    runId: args["run-id"],
    expectedBranch: args["expected-branch"],
    sessionDir: args["session-dir"],
    monitorDir: args["monitor-dir"],
    journal: args.journal,
    traceState: args["trace-state"],
    supervisorMarker: args["supervisor-marker"],
    ownerFile: args["owner-file"],
    ownerToken: args["owner-token"],
    traceSeconds: args["trace-seconds"],
    supervisorSeconds: args["supervisor-seconds"],
    supervisorEvery: args["supervisor-every"],
  }).catch((error) => {
    process.stderr.write(`swarm-monitor-daemon: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
