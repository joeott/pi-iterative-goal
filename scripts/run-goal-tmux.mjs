#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPOSITORY_ROOT } from "./lib/model-runtime.mjs";

const options = parseArgs(process.argv.slice(2));
const runId = options.runId ?? `goal-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new Error("run id must be 1-64 safe characters");
const socket = `pi-goal-${runId}`;
const session = `pi-goal-${runId}`;
const piDir = path.resolve(options.piDir ?? path.join(REPOSITORY_ROOT, ".pi", "iterative-goal", "runtime", runId, "pi-agent"));
const launcher = path.join(REPOSITORY_ROOT, "scripts", "run-goal-runtime.mjs");
const launchArgs = [launcher, "--pi-dir", piDir, "--", ...options.piArgs];
const command = [process.execPath, ...launchArgs].map(shellQuote).join(" ");

console.log("goal_tmux_launcher");
console.log(`mode: ${options.start ? "start" : "preview"}`);
console.log(`run_id: ${runId}`);
console.log(`socket: ${socket}`);
console.log(`session: ${session}`);
console.log(`pi_coding_agent_dir: ${piDir}`);
console.log("default_tmux_server_touched: false");
console.log(`attach: tmux -L ${shellQuote(socket)} attach-session -t ${shellQuote(session)}`);
console.log(`stop: tmux -L ${shellQuote(socket)} kill-session -t ${shellQuote(session)}`);

if (!options.start) {
  console.log("launch: SKIPPED (--start is required)");
  process.exit(0);
}
const availability = spawnSync("tmux", ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (availability.status !== 0) throw new Error("tmux is unavailable");
const existing = spawnSync("tmux", ["-L", socket, "has-session", "-t", session], { stdio: "ignore" });
if (existing.status === 0) throw new Error(`private tmux session already exists: ${socket}/${session}`);
const started = spawnSync("tmux", ["-L", socket, "new-session", "-d", "-s", session, command], {
  cwd: REPOSITORY_ROOT,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (started.status !== 0) throw new Error(`tmux start failed: ${(started.stderr || "unknown error").trim().slice(0, 300)}`);
writeReceipt(path.join(REPOSITORY_ROOT, ".pi", "iterative-goal", "runtime", runId, "tmux-launch.json"), {
  schema: "pi-iterative-goal.tmux-launch.v1",
  startedAt: new Date().toISOString(),
  runId,
  socket,
  session,
  piCodingAgentDir: piDir,
  pid: process.pid,
});
console.log("launch: PASS");

function parseArgs(args) {
  const result = { start: false, runId: undefined, piDir: undefined, piArgs: [] };
  let passthrough = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (passthrough) result.piArgs.push(arg);
    else if (arg === "--") passthrough = true;
    else if (arg === "--start") result.start = true;
    else if (arg === "--run-id" || arg === "--pi-dir") {
      if (!args[index + 1]) throw new Error(`${arg} requires a value`);
      result[arg === "--run-id" ? "runId" : "piDir"] = args[++index];
    } else if (arg === "--help") {
      console.log("usage: run-goal-tmux.mjs [--start] [--run-id ID] [--pi-dir DIR] [-- PI_ARGS...]");
      process.exit(0);
    } else throw new Error(`tmux launcher argument must precede --; unknown argument: ${arg}`);
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeReceipt(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`refusing receipt symlink: ${filePath}`);
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
