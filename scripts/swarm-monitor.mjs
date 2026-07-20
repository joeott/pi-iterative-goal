#!/usr/bin/env node
/**
 * Own a long-session monitor in a run-private tmux server.
 *
 * Every tmux server operation includes an explicit -S socket. The computed
 * socket is unique to (real repo path, run id), and stop validates the on-disk
 * ownership record before killing only that exact session.
 */

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeRunId,
  DEFAULT_SUPERVISOR_SECONDS,
  DEFAULT_TRACE_SECONDS,
} from "./swarm-monitor-trace.mjs";
import { ensureManagedRoot } from "../dist/logging.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command.startsWith("--")) throw new Error("Usage: swarm-monitor.mjs <start|status|stop|ack-supervisor> --run-id <id> [options]");
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function gitBranch(repo) {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveExecutable(command) {
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`tmux binary is not executable: ${command}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function monitorLayout(repoInput, runIdInput) {
  const repo = fs.realpathSync(path.resolve(repoInput));
  const runId = assertSafeRunId(runIdInput);
  const digest = crypto.createHash("sha256").update(`${repo}\0${runId}`).digest("hex").slice(0, 20);
  const slug = runId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24);
  const managedRoot = ensureManagedRoot(repo);
  const monitorDir = path.join(managedRoot, "monitor", "runs", runId);
  return {
    repo,
    runId,
    managedRoot,
    monitorDir,
    activeMarker: path.join(monitorDir, "ACTIVE.json"),
    journal: path.join(monitorDir, "journal.log"),
    traceState: path.join(monitorDir, "trace-state.json"),
    supervisorMarker: path.join(monitorDir, "SUPERVISOR_DUE.json"),
    socketPath: path.join("/tmp", `pi-ig-monitor-${digest}.sock`),
    sessionName: `pi-ig-${slug}-${digest.slice(0, 8)}`,
  };
}

function ensureOwnedMonitorDirectory(layout) {
  let cursor = layout.managedRoot;
  const relative = path.relative(layout.managedRoot, layout.monitorDir);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`monitor path is not a real directory: ${cursor}`);
  }
  const resolved = fs.realpathSync(layout.monitorDir);
  const resolvedRelative = path.relative(fs.realpathSync(layout.managedRoot), resolved);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) throw new Error("monitor directory escapes managed root");
}

function tmuxCall(owner, args, { allowFailure = false } = {}) {
  const result = spawnSync(owner.tmuxBin, ["-S", owner.socketPath, ...args], {
    cwd: owner.repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`private tmux command failed: ${detail}`);
  }
  return result;
}

function tmuxHasSession(owner) {
  const result = tmuxCall(owner, ["has-session", "-t", owner.sessionName], { allowFailure: true });
  return !result.error && result.status === 0;
}

function validateOwner(owner, expected, expectedTmuxBin) {
  const checks = [
    [owner.schemaVersion === 1, "schema version"],
    [owner.runId === expected.runId, "run id"],
    [path.resolve(owner.repo ?? "") === expected.repo, "repo"],
    [owner.socketPath === expected.socketPath, "private tmux socket"],
    [owner.sessionName === expected.sessionName, "tmux session"],
    [owner.monitorDir === expected.monitorDir, "monitor directory"],
    [owner.tmuxBin === expectedTmuxBin, "tmux binary"],
  ];
  const mismatch = checks.find(([valid]) => !valid);
  if (mismatch) throw new Error(`refusing monitor operation: ownership ${mismatch[1]} mismatch`);
  if (typeof owner.ownerToken !== "string" || owner.ownerToken.length < 16) {
    throw new Error("refusing monitor operation: invalid ownership token");
  }
  return owner;
}

function removeIfOwned(markerPath, ownerToken) {
  if (!fs.existsSync(markerPath)) return false;
  const current = readJson(markerPath);
  if (current.ownerToken !== ownerToken) throw new Error("monitor ownership changed during cleanup");
  fs.unlinkSync(markerPath);
  return true;
}

function daemonCommand(owner) {
  const daemonPath = fileURLToPath(new URL("./swarm-monitor-daemon.mjs", import.meta.url));
  const pairs = [
    ["repo", owner.repo],
    ["run-id", owner.runId],
    ["expected-branch", owner.expectedBranch],
    ["monitor-dir", owner.monitorDir],
    ["journal", owner.journal],
    ["trace-state", owner.traceState],
    ["supervisor-marker", owner.supervisorMarker],
    ["owner-file", owner.activeMarker],
    ["owner-token", owner.ownerToken],
    ["trace-seconds", owner.traceSeconds],
    ["supervisor-seconds", owner.supervisorSeconds],
    ["supervisor-every", owner.supervisorEvery],
  ];
  if (owner.sessionDir) pairs.push(["session-dir", owner.sessionDir]);
  const argv = [process.execPath, daemonPath, ...pairs.flatMap(([name, value]) => [`--${name}`, String(value)])];
  return argv.map(shellQuote).join(" ");
}

export function startMonitor(input) {
  const layout = monitorLayout(input.repo ?? process.cwd(), input.runId);
  const tmuxBin = resolveExecutable(input.tmuxBin || "tmux");
  const traceSeconds = positiveInteger(input.traceSeconds ?? DEFAULT_TRACE_SECONDS, "trace-seconds");
  const supervisorSeconds = positiveInteger(input.supervisorSeconds ?? DEFAULT_SUPERVISOR_SECONDS, "supervisor-seconds");
  if (supervisorSeconds % traceSeconds !== 0) {
    throw new Error("supervisor-seconds must be an exact multiple of trace-seconds");
  }

  if (fs.existsSync(layout.activeMarker)) {
    const existing = validateOwner(readJson(layout.activeMarker), layout, tmuxBin);
    if (tmuxHasSession(existing)) {
      return { status: "already_running", ...layout, ownerToken: existing.ownerToken };
    }
    removeIfOwned(layout.activeMarker, existing.ownerToken);
  } else if (fs.existsSync(layout.socketPath)) {
    // With no ownership receipt there is no safe target identity to prove.
    // Never attach to, enumerate, kill, or unlink an unowned socket.
    throw new Error(`refusing monitor start: unowned private tmux socket exists at ${layout.socketPath}`);
  }

  const owner = {
    schemaVersion: 1,
    ...layout,
    ownerToken: crypto.randomBytes(16).toString("hex"),
    expectedBranch: input.expectedBranch || gitBranch(layout.repo),
    sessionDir: input.sessionDir ? path.resolve(input.sessionDir) : "",
    traceSeconds,
    supervisorSeconds,
    supervisorEvery: supervisorSeconds / traceSeconds,
    tmuxBin,
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
  };
  ensureOwnedMonitorDirectory(owner);
  writeJsonAtomic(owner.activeMarker, owner);
  try {
    tmuxCall(owner, ["new-session", "-d", "-s", owner.sessionName, daemonCommand(owner)]);
  } catch (error) {
    removeIfOwned(owner.activeMarker, owner.ownerToken);
    throw error;
  }
  return { status: "started", ...layout, ownerToken: owner.ownerToken };
}

export function monitorStatus(input) {
  const layout = monitorLayout(input.repo ?? process.cwd(), input.runId);
  if (!fs.existsSync(layout.activeMarker)) {
    return { status: "stopped", active: false, ...layout, supervisorDue: fs.existsSync(layout.supervisorMarker) };
  }
  const tmuxBin = resolveExecutable(input.tmuxBin || "tmux");
  const owner = validateOwner(readJson(layout.activeMarker), layout, tmuxBin);
  const active = tmuxHasSession(owner);
  let trace = null;
  if (fs.existsSync(layout.traceState)) {
    try { trace = readJson(layout.traceState); } catch { trace = null; }
  }
  return {
    status: active ? "running" : "stale_owner",
    active,
    ...layout,
    expectedBranch: owner.expectedBranch,
    traceSeconds: owner.traceSeconds,
    supervisorSeconds: owner.supervisorSeconds,
    trace,
    supervisorDue: fs.existsSync(layout.supervisorMarker),
  };
}

export function stopMonitor(input) {
  const layout = monitorLayout(input.repo ?? process.cwd(), input.runId);
  if (!fs.existsSync(layout.activeMarker)) {
    return { status: "already_stopped", ...layout };
  }
  const tmuxBin = resolveExecutable(input.tmuxBin || "tmux");
  const owner = validateOwner(readJson(layout.activeMarker), layout, tmuxBin);
  if (input.ownerToken && input.ownerToken !== owner.ownerToken) {
    throw new Error("refusing monitor stop: supplied ownership token does not match");
  }

  // Removing the exact marker first makes the daemon's next ownership check
  // fail even if tmux exits concurrently. Then kill only the validated session
  // on its run-private socket; never enumerate or contact the default server.
  removeIfOwned(layout.activeMarker, owner.ownerToken);
  if (tmuxHasSession(owner)) {
    tmuxCall(owner, ["kill-session", "-t", owner.sessionName]);
  }
  // The socket is one-server-per-run, so terminating that private server is
  // still exact-owned cleanup. It also prevents a later start from attaching
  // to a dormant server that outlived its only session.
  const serverStop = tmuxCall(owner, ["kill-server"], { allowFailure: true });
  if (!serverStop.error && serverStop.status === 0 && fs.existsSync(layout.socketPath)) {
    fs.unlinkSync(layout.socketPath);
  }
  if (fs.existsSync(layout.socketPath)) {
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 20 && fs.existsSync(layout.socketPath); attempt += 1) {
      Atomics.wait(waiter, 0, 0, 25);
    }
    // tmux can unlink its socket slightly after kill-server returns. If the
    // exact run-private pathname is still stale after that grace period, it is
    // safe to remove: ownership was validated and both the session and its
    // one-run server have already received termination commands.
    if (fs.existsSync(layout.socketPath)) fs.unlinkSync(layout.socketPath);
  }
  if (fs.existsSync(layout.supervisorMarker)) fs.unlinkSync(layout.supervisorMarker);
  return { status: "stopped", ...layout };
}

export function acknowledgeSupervisor(input) {
  const layout = monitorLayout(input.repo ?? process.cwd(), input.runId);
  if (!fs.existsSync(layout.supervisorMarker)) {
    return { status: "not_due", ...layout };
  }
  const due = readJson(layout.supervisorMarker);
  if (due.runId !== layout.runId) throw new Error("refusing supervisor acknowledgement: run-id mismatch");
  fs.unlinkSync(layout.supervisorMarker);
  return { status: "acknowledged", tick: due.tick, ...layout };
}

function inputFromOptions(options) {
  return {
    repo: options.repo,
    runId: options["run-id"],
    expectedBranch: options["expected-branch"] ?? options.branch,
    sessionDir: options["session-dir"],
    traceSeconds: options["trace-seconds"],
    supervisorSeconds: options["supervisor-seconds"],
    tmuxBin: options["tmux-bin"],
    ownerToken: options["owner-token"],
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const input = inputFromOptions(options);
    if (!input.runId) throw new Error("--run-id is required");
    const operations = {
      start: startMonitor,
      status: monitorStatus,
      stop: stopMonitor,
      "ack-supervisor": acknowledgeSupervisor,
    };
    const operation = operations[command];
    if (!operation) throw new Error(`Unknown command: ${command}`);
    process.stdout.write(`${JSON.stringify(operation(input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`swarm-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
