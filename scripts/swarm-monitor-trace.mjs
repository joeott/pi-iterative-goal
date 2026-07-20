#!/usr/bin/env node
/**
 * Append one deterministic, run-scoped monitor snapshot.
 *
 * The tracer is intentionally model-free. It reads the durable harness state,
 * the tail of the hash-chained event log, git state, and optional subagent log
 * metadata. Every fourth production tick marks the 24-minute supervisor wake
 * due (4 * 360 seconds) without attempting to contact a model itself.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ensureManagedRoot } from "../dist/logging.js";

export const DEFAULT_TRACE_SECONDS = 360;
export const DEFAULT_SUPERVISOR_SECONDS = 1_440;
const JOURNAL_ROTATE_BYTES = 10 * 1024 * 1024;
const JOURNAL_ROTATIONS = 3;

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function assertSafeRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("run-id must use 1-128 alphanumeric, dot, underscore, or dash characters");
  }
  return runId;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function git(repo, args, fallback = "unknown") {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return fallback;
  }
}

function resolveActiveRunId(repo) {
  const activePath = path.join(repo, ".pi", "iterative-goal", "active-run.json");
  if (!fs.existsSync(activePath)) return "";
  try {
    const lock = readJson(activePath);
    return typeof lock.activeRunId === "string" ? lock.activeRunId : "";
  } catch {
    return "";
  }
}

function readLastJsonLine(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return null;
  const bytesToRead = Math.min(stat.size, 512 * 1024);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString("utf8");
  if (bytesToRead < stat.size) text = text.slice(text.indexOf("\n") + 1);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore an incomplete/corrupt tail here; replay remains the authority.
    }
  }
  return null;
}

function readState(runDir) {
  const statePath = path.join(runDir, "state.json");
  if (!fs.existsSync(statePath)) return null;
  try {
    const envelope = readJson(statePath);
    return envelope?.state ?? null;
  } catch {
    return null;
  }
}

function countDirtyFiles(repo) {
  const porcelain = git(repo, ["status", "--porcelain=v1"], "");
  if (!porcelain) return 0;
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\?\? \.pi(?:\/|$)/.test(line))
    .length;
}

function taskSnapshots(sessionDir) {
  const tasksDir = sessionDir ? path.join(sessionDir, "agents", "main", "tasks") : "";
  if (!tasksDir || !fs.existsSync(tasksDir)) return [];
  const snapshots = [];
  for (const entry of fs.readdirSync(tasksDir).sort()) {
    const logPath = path.join(tasksDir, entry, "output.log");
    try {
      const stat = fs.statSync(logPath);
      snapshots.push({
        id: entry,
        outputBytes: stat.size,
        outputMtime: stat.mtime.toISOString(),
      });
    } catch {
      // A task may still be initializing and not have an output.log yet.
    }
  }
  return snapshots;
}

function summarizeState(state, nowMs, supervisorSeconds) {
  const evaluator = state?.evaluatorState ?? null;
  const heartbeatMs = evaluator?.lastHeartbeatAt ? Date.parse(evaluator.lastHeartbeatAt) : Number.NaN;
  const heartbeatAgeSeconds = Number.isFinite(heartbeatMs)
    ? Math.max(0, Math.floor((nowMs - heartbeatMs) / 1000))
    : null;
  const swarmTasks = Array.isArray(state?.swarm?.tasks) ? state.swarm.tasks : [];
  const count = (status) => swarmTasks.filter((task) => task.status === status).length;
  return {
    harness: {
      status: state?.status ?? "missing",
      cycle: state?.cycle ?? null,
      phase: state?.phase ?? null,
      activePhaseId: state?.lock?.activePhaseId ?? null,
      phaseStatus: state?.lock?.phaseStatus ?? null,
    },
    evaluator: {
      status: evaluator?.status ?? "none",
      lastHeartbeatAt: evaluator?.lastHeartbeatAt ?? null,
      heartbeatAgeSeconds,
      stale: evaluator?.status === "stale_heartbeat"
        || (heartbeatAgeSeconds !== null && heartbeatAgeSeconds >= supervisorSeconds),
    },
    swarm: {
      total: swarmTasks.length,
      running: count("running"),
      completed: count("completed"),
      failed: count("failed"),
      cancelled: count("cancelled"),
    },
  };
}

function monitorHeader(config) {
  return [
    "# pi-iterative-goal swarm monitor journal",
    "format: v2-jsonl",
    `run_id: ${config.runId}`,
    `expected_branch: ${config.expectedBranch}`,
    `trace_seconds: ${config.traceSeconds}`,
    `supervisor_seconds: ${config.supervisorSeconds}`,
    "records: one canonical JSON object per trace tick",
  ].join("\n") + "\n";
}

function assertOwner(config) {
  if (!config.ownerFile) return;
  if (!fs.existsSync(config.ownerFile)) throw new Error("monitor ownership marker is absent");
  const owner = readJson(config.ownerFile);
  if (owner.ownerToken !== config.ownerToken) throw new Error("monitor ownership token changed");
  if (owner.runId !== config.runId) throw new Error("monitor ownership run-id changed");
  if (path.resolve(owner.repo) !== config.repo) throw new Error("monitor ownership repo changed");
}

export function normalizeTraceConfig(input) {
  const repo = fs.realpathSync(path.resolve(input.repo ?? process.cwd()));
  const runId = assertSafeRunId(input.runId || resolveActiveRunId(repo));
  const runDir = path.join(repo, ".pi", "iterative-goal", "runs", runId);
  const expectedMonitorDir = path.join(ensureManagedRoot(repo), "monitor", "runs", runId);
  const monitorDir = path.resolve(input.monitorDir ?? expectedMonitorDir);
  if (monitorDir !== expectedMonitorDir) throw new Error("monitor-dir must be the exact owned run directory");
  fs.mkdirSync(monitorDir, { recursive: true, mode: 0o700 });
  const monitorStat = fs.lstatSync(monitorDir);
  if (monitorStat.isSymbolicLink() || !monitorStat.isDirectory()) throw new Error("monitor-dir is not a real directory");
  const managedRoot = fs.realpathSync(path.join(repo, ".pi", "iterative-goal", "managed"));
  const realMonitorDir = fs.realpathSync(monitorDir);
  const realMonitorRelative = path.relative(managedRoot, realMonitorDir);
  if (realMonitorRelative.startsWith("..") || path.isAbsolute(realMonitorRelative)) throw new Error("monitor-dir resolves outside managed root");
  const traceSeconds = positiveInteger(input.traceSeconds ?? DEFAULT_TRACE_SECONDS, "trace-seconds");
  const supervisorSeconds = positiveInteger(input.supervisorSeconds ?? DEFAULT_SUPERVISOR_SECONDS, "supervisor-seconds");
  if (supervisorSeconds % traceSeconds !== 0) {
    throw new Error("supervisor-seconds must be an exact multiple of trace-seconds");
  }
  const supervisorEvery = positiveInteger(input.supervisorEvery ?? supervisorSeconds / traceSeconds, "supervisor-every");
  if (supervisorEvery !== supervisorSeconds / traceSeconds) {
    throw new Error("supervisor-every must equal supervisor-seconds / trace-seconds");
  }
  return {
    repo,
    runId,
    runDir,
    expectedBranch: input.expectedBranch || git(repo, ["branch", "--show-current"], "unknown"),
    sessionDir: input.sessionDir ? path.resolve(input.sessionDir) : "",
    monitorDir,
    journal: exactMonitorPath(input.journal, path.join(monitorDir, "journal.log"), "journal"),
    traceState: exactMonitorPath(input.traceState, path.join(monitorDir, "trace-state.json"), "trace-state"),
    supervisorMarker: exactMonitorPath(input.supervisorMarker, path.join(monitorDir, "SUPERVISOR_DUE.json"), "supervisor-marker"),
    ownerFile: input.ownerFile ? path.resolve(input.ownerFile) : "",
    ownerToken: input.ownerToken ?? "",
    traceSeconds,
    supervisorSeconds,
    supervisorEvery,
    now: input.now ? new Date(input.now) : new Date(),
  };
}

function exactMonitorPath(input, expected, label) {
  const resolved = path.resolve(input ?? expected);
  if (resolved !== expected) throw new Error(`${label} must use the exact owned monitor path`);
  return resolved;
}

function rotateJournal(filePath, header) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("monitor journal is not a real file");
  if (stat.size < JOURNAL_ROTATE_BYTES) return;
  const oldest = `${filePath}.${JOURNAL_ROTATIONS}.gz`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let generation = JOURNAL_ROTATIONS - 1; generation >= 1; generation -= 1) {
    const source = `${filePath}.${generation}.gz`;
    if (fs.existsSync(source)) fs.renameSync(source, `${filePath}.${generation + 1}.gz`);
  }
  fs.writeFileSync(`${filePath}.1.gz`, zlib.gzipSync(fs.readFileSync(filePath), { level: zlib.constants.Z_BEST_SPEED }), { mode: 0o600 });
  fs.writeFileSync(filePath, header, { mode: 0o600 });
}

export function traceOnce(input) {
  const config = normalizeTraceConfig(input);
  if (!Number.isFinite(config.now.getTime())) throw new Error("now must be a valid ISO timestamp");
  assertOwner(config);

  let previous = { schemaVersion: 1, runId: config.runId, tick: 0, lastTickAt: null };
  if (fs.existsSync(config.traceState)) {
    previous = readJson(config.traceState);
    if (previous.runId !== config.runId) throw new Error("trace-state belongs to a different run");
  }
  const tick = positiveInteger((previous.tick ?? 0) + 1, "tick");
  const supervisorDue = tick % config.supervisorEvery === 0;
  const timestamp = config.now.toISOString();
  const actualBranch = git(config.repo, ["branch", "--show-current"]);
  const state = readState(config.runDir);
  const lastEvent = readLastJsonLine(path.join(config.runDir, "events.jsonl"));
  const summarized = summarizeState(state, config.now.getTime(), config.supervisorSeconds);

  const record = {
    schemaVersion: 2,
    tick,
    timestamp,
    runId: config.runId,
    expectedBranch: config.expectedBranch,
    branch: actualBranch,
    branchMatches: actualBranch === config.expectedBranch,
    head: git(config.repo, ["rev-parse", "--short", "HEAD"]),
    dirtyFiles: countDirtyFiles(config.repo),
    ...summarized,
    lastEvent: lastEvent ? {
      sequence: lastEvent.sequence ?? null,
      eventHash: lastEvent.eventHash ?? null,
      timestamp: lastEvent.timestamp ?? null,
      type: lastEvent.type ?? null,
    } : null,
    taskLogs: taskSnapshots(config.sessionDir),
    supervisor: {
      due: supervisorDue,
      everyTicks: config.supervisorEvery,
      cadenceSeconds: config.supervisorSeconds,
    },
  };

  fs.mkdirSync(path.dirname(config.journal), { recursive: true });
  const header = monitorHeader(config);
  if (!fs.existsSync(config.journal)) {
    fs.writeFileSync(config.journal, header, { mode: 0o600 });
  } else {
    const buffer = Buffer.alloc(header.length);
    const fd = fs.openSync(config.journal, "r");
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const existingHeader = buffer.subarray(0, bytesRead).toString("utf8");
    if (existingHeader !== header) throw new Error("journal header does not match this monitor configuration");
  }
  rotateJournal(config.journal, header);
  fs.appendFileSync(config.journal, `${JSON.stringify(record)}\n`);
  writeJsonAtomic(config.traceState, {
    schemaVersion: 1,
    runId: config.runId,
    tick,
    lastTickAt: timestamp,
    lastEventSequence: record.lastEvent?.sequence ?? null,
    lastEventHash: record.lastEvent?.eventHash ?? null,
  });
  if (supervisorDue) {
    writeJsonAtomic(config.supervisorMarker, {
      schemaVersion: 1,
      runId: config.runId,
      tick,
      dueAt: timestamp,
      lastEventSequence: record.lastEvent?.sequence ?? null,
      lastEventHash: record.lastEvent?.eventHash ?? null,
    });
  }
  return record;
}

function configFromArgv(argv) {
  const args = parseArgs(argv);
  return {
    repo: args.get("repo"),
    runId: args.get("run-id"),
    expectedBranch: args.get("expected-branch") ?? args.get("branch"),
    sessionDir: args.get("session-dir"),
    monitorDir: args.get("monitor-dir"),
    journal: args.get("journal"),
    traceState: args.get("trace-state"),
    supervisorMarker: args.get("supervisor-marker"),
    ownerFile: args.get("owner-file"),
    ownerToken: args.get("owner-token"),
    traceSeconds: args.get("trace-seconds"),
    supervisorSeconds: args.get("supervisor-seconds"),
    supervisorEvery: args.get("supervisor-every"),
    now: args.get("now"),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const record = traceOnce(configFromArgv(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(`swarm-monitor-trace: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
