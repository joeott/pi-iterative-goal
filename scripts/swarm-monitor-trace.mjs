#!/usr/bin/env node
// swarm-monitor-trace.mjs — append one deterministic, timestamped trace entry to the
// swarm monitor journal. Designed to be invoked on a fixed cadence (see
// ai_docs/swarm-monitor-convention.md). No model involvement; pure fs/git snapshot.
//
// Usage: node scripts/swarm-monitor-trace.mjs --session-dir <dir> [--repo <dir>] [--journal <path>]

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = path.resolve(arg("repo", process.cwd()));
const sessionDir = arg("session-dir", "");
const journal = path.resolve(arg("journal", path.join(repo, ".pi/iterative-goal/monitor/swarm-c0-c4.journal.log")));

const HEADER = [
  "# pi-iterative-goal swarm monitor journal",
  "format: v1",
  "repo: pi-iterative-goal",
  "branch: feat/deployment-plan-c0-c4",
  "cadence_seconds: 360",
  "columns: iso_ts | head | dirty_files | tasks(id:out_bytes:out_mtime_iso)",
].join("\n");

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

function taskSnapshots() {
  const tasksDir = sessionDir ? path.join(sessionDir, "agents", "main", "tasks") : "";
  if (!tasksDir || !fs.existsSync(tasksDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(tasksDir).sort()) {
    const logPath = path.join(tasksDir, entry, "output.log");
    try {
      const st = fs.statSync(logPath);
      out.push(`${entry.replace(/^agent-/, "a-").slice(0, 12)}:${st.size}:${st.mtime.toISOString()}`);
    } catch {
      // No output.log yet (task still initializing) — omit from the snapshot.
    }
  }
  return out;
}

fs.mkdirSync(path.dirname(journal), { recursive: true });
if (!fs.existsSync(journal)) {
  fs.writeFileSync(journal, HEADER + "\n");
}

const ts = new Date().toISOString();
const head = git("rev-parse --short HEAD");
const dirty = git("status --porcelain").split("\n").filter((l) => l.trim() && !l.startsWith("?? .pi/")).length;
const tasks = taskSnapshots().join(" ") || "-";
fs.appendFileSync(journal, `${ts} | head=${head} | dirty=${dirty} | ${tasks}\n`);
