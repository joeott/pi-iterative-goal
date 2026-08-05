#!/usr/bin/env node
/** Targeted regression tests for restart/reload lifecycle and private monitor ownership. */

import { deepStrictEqual, ok, strictEqual as eq, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeGitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "monitor-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Monitor Test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
  return repo;
}

function snapshot() {
  return {
    activeTools: [],
    allTools: [],
    commands: [],
    hasBashTool: false,
    hasSubagentTool: false,
    hasAgentTool: false,
    hasMcpTool: false,
    mcpServers: [],
    model: "test/model",
    provider: "test",
    awsCli: null,
    gitFinalization: null,
    hasFilesystem: true,
    hasGit: true,
    hasNetwork: false,
    hasAws: false,
    hasAwsConfig: false,
    hasAwsSecurityHub: false,
    hasAwsAccessAnalyzer: false,
    hasScannerTools: false,
    hasSandbox: true,
    hasDlpProxy: true,
    hasIpiSanitizer: true,
    hasEvidenceSigner: true,
    cyberCapabilities: [],
    unavailableCapabilities: [],
  };
}

function phaseAttempt(runId, attempt = 1) {
  return {
    runId,
    cycle: 1,
    phase: "research",
    attempt,
    phaseAttemptId: `${runId}/c1/research/a${attempt}`,
    modelProvider: "test",
    modelModel: "model",
    fallbackChain: [],
    startedAt: new Date().toISOString(),
    status: "running",
    outputReceived: false,
    resultParsed: false,
    artifactsPersisted: false,
    resultCommitted: false,
  };
}

function makeLifecycleRig(repo, createStateManager) {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const notifications = [];
  const pi = {
    appendEntry() {},
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(message) { sent.push(String(message)); },
    async setModel() { return true; },
  };
  const stateManager = createStateManager(pi);
  const ctx = {
    cwd: repo,
    hasUI: true,
    modelRegistry: {
      find(provider, model) {
        return provider === "zai" && model === "glm-5.2" ? { provider, id: model, model } : undefined;
      },
    },
    sessionManager: { getEntries: () => [] },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      async confirm() { return true; },
    },
  };
  const services = { buildRuntimeCapabilitySnapshot: async () => snapshot(), log() {} };
  return { pi, handlers, commands, sent, notifications, stateManager, ctx, services };
}

// Lifecycle: true restart retires one interrupted attempt, duplicate start is
// inert, and reload rehydrates without minting another nonce or prompt.
{
  const { createStateManager } = await import("../dist/state.js");
  const { registerGoalLifecycle } = await import("../dist/kernel/lifecycle.js");
  const repo = makeGitRepo("pi-ig-session-idempotence-");
  const rig = makeLifecycleRig(repo, createStateManager);
  eq(rig.stateManager.restore(rig.ctx), null);
  const run = rig.stateManager.createRun("Resume once", "One live attempt per phase");
  const initial = phaseAttempt(run.runId, 1);
  rig.stateManager.startPhaseAttempt(initial);
  rig.stateManager.acquireLock(run.runId, initial.phaseAttemptId);
  registerGoalLifecycle(rig.pi, rig.stateManager, rig.services);

  await rig.handlers.get("session_start")({ reason: "startup" }, rig.ctx);
  let attempts = rig.stateManager.getState().phaseAttempts;
  eq(attempts.length, 2);
  eq(attempts[0].status, "cancelled", "interrupted pre-start attempt is closed");
  eq(attempts[1].status, "running");
  eq(rig.sent.length, 1, "startup queues one resume prompt");

  await rig.handlers.get("session_start")({ reason: "startup" }, rig.ctx);
  attempts = rig.stateManager.getState().phaseAttempts;
  eq(attempts.length, 2, "duplicate session_start is idempotent");
  eq(rig.sent.length, 1, "duplicate session_start queues no prompt");

  await rig.handlers.get("session_shutdown")({ reason: "reload" }, rig.ctx);
  await rig.handlers.get("session_start")({ reason: "reload" }, rig.ctx);
  attempts = rig.stateManager.getState().phaseAttempts;
  eq(attempts.length, 2, "reload preserves the active attempt");
  eq(attempts[1].status, "running");
  eq(rig.sent.length, 1, "reload queues no duplicate resume prompt");
  console.log("✓ lifecycle session_start/reload is attempt- and prompt-idempotent");
}

// Lifecycle: the second synthetic capture failure becomes a durable resumable
// pause, and the existing /goal-resume path can start the next attempt.
{
  const { createStateManager } = await import("../dist/state.js");
  const { registerGoalLifecycle } = await import("../dist/kernel/lifecycle.js");
  const { registerGoalRuntimeCommands } = await import("../dist/ui/goal-commands.js");
  const repo = makeGitRepo("pi-ig-capture-pause-");
  const rig = makeLifecycleRig(repo, createStateManager);
  eq(rig.stateManager.restore(rig.ctx), null);
  const run = rig.stateManager.createRun("Capture output", "Persistent empty output pauses for repair");
  const initial = phaseAttempt(run.runId, 1);
  rig.stateManager.startPhaseAttempt(initial);
  rig.stateManager.acquireLock(run.runId, initial.phaseAttemptId);
  registerGoalLifecycle(rig.pi, rig.stateManager, rig.services);

  const emptyAgentEnd = { messages: [{ role: "assistant", content: [] }] };
  await rig.handlers.get("agent_end")(emptyAgentEnd, rig.ctx);
  eq(rig.stateManager.getState().status, "running", "first failure retries automatically");
  eq(rig.stateManager.getState().phaseAttempts.length, 2);
  await rig.handlers.get("agent_end")(emptyAgentEnd, rig.ctx);
  eq(rig.stateManager.getState().status, "paused_by_user");
  eq(rig.stateManager.getState().lock.phaseStatus, "paused");
  ok(rig.notifications.at(-1).message.includes("synthetic output capture failure"));

  const restoredPi = {
    appendEntry() {},
    registerCommand(name, command) { rig.commands.set(name, command); },
    sendUserMessage(message) { rig.sent.push(String(message)); },
    async setModel() { return true; },
  };
  const restoredManager = createStateManager(restoredPi);
  const restored = restoredManager.restore(rig.ctx);
  eq(restored.status, "paused_by_user", "pause survives hash-chain replay");
  registerGoalRuntimeCommands(
    restoredPi,
    restoredManager,
    rig.services,
    { clearSurfaces() {}, stop() {}, tickOnce() {}, setHeaderFactory() {}, trackDashboard() {} },
  );
  await rig.commands.get("goal-resume").handler("", rig.ctx);
  eq(restoredManager.getState().status, "running");
  eq(restoredManager.getState().phaseAttempts.length, 3, "/goal-resume starts one fresh attempt");
  eq(restoredManager.getState().phaseAttempts.at(-1).status, "running");
  console.log("✓ repeated synthetic capture failure durably pauses and /goal-resume recovers");
}

// Tracer: richer state/event/task fields, exact 6-minute ticks, and the fourth
// tick marks the 24-minute supervisor reconciliation due.
{
  const { traceOnce } = await import("./swarm-monitor-trace.mjs");
  const repo = makeGitRepo("pi-ig-monitor-trace-");
  const runId = "ig-monitor-trace";
  const runDir = path.join(repo, ".pi", "iterative-goal", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    version: 2,
    state: {
      runId,
      status: "running",
      cycle: 3,
      phase: "implement",
      lock: { activePhaseId: `${runId}/c3/implement/a2`, phaseStatus: "running" },
      evaluatorState: {
        status: "running",
        lastHeartbeatAt: "2026-07-20T12:00:00.000Z",
      },
      swarm: {
        tasks: [
          { status: "running" },
          { status: "completed" },
          { status: "failed" },
        ],
      },
    },
  }));
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
    type: "phase_lifecycle",
    sequence: 41,
    eventHash: "event-hash-41",
    timestamp: "2026-07-20T12:00:00.000Z",
  })}\n`);
  const sessionDir = path.join(repo, "session");
  const taskDir = path.join(sessionDir, "agents", "main", "tasks", "agent-a");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "output.log"), "working\n");

  const common = {
    repo,
    runId,
    expectedBranch: "main",
    sessionDir,
    traceSeconds: 360,
    supervisorSeconds: 1_440,
  };
  const records = [];
  for (let tick = 0; tick < 4; tick += 1) {
    records.push(traceOnce({ ...common, now: new Date(Date.UTC(2026, 6, 20, 12, (tick + 1) * 6)).toISOString() }));
  }
  deepStrictEqual(records.map((record) => record.tick), [1, 2, 3, 4]);
  eq(records[3].supervisor.due, true);
  eq(records[3].supervisor.cadenceSeconds, 1_440);
  eq(records[3].harness.activePhaseId, `${runId}/c3/implement/a2`);
  eq(records[3].lastEvent.sequence, 41);
  eq(records[3].lastEvent.eventHash, "event-hash-41");
  deepStrictEqual(records[3].swarm, { total: 3, running: 1, completed: 1, failed: 1, cancelled: 0 });
  eq(records[3].taskLogs[0].id, "agent-a");

  const monitorDir = path.join(repo, ".pi", "iterative-goal", "managed", "monitor", "runs", runId);
  const journalRecords = fs.readFileSync(path.join(monitorDir, "journal.log"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  eq(journalRecords.length, 4);
  eq(JSON.parse(fs.readFileSync(path.join(monitorDir, "SUPERVISOR_DUE.json"), "utf8")).tick, 4);
  console.log("✓ monitor traces rich run state and marks the 24-minute supervisor wake on tick four");
}

// Controller: idempotent start, exact ownership validation, and every tmux
// operation carries the private -S socket. The fake never launches a daemon.
{
  const { monitorLayout, monitorStatus, startMonitor, stopMonitor } = await import("./swarm-monitor.mjs");
  const repo = makeGitRepo("pi-ig-monitor-owner-");
  const runId = "ig-monitor-owner";
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-fake-tmux-"));
  const fakeTmux = path.join(fakeDir, "tmux");
  const logPath = path.join(fakeDir, "calls.log");
  const alivePath = path.join(fakeDir, "alive");
  fs.writeFileSync(fakeTmux, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$PI_IG_FAKE_TMUX_LOG\"",
    "case \"$*\" in",
    "  *has-session*) test -f \"$PI_IG_FAKE_TMUX_ALIVE\" ;;",
    "  *new-session*) : > \"$PI_IG_FAKE_TMUX_ALIVE\" ;;",
    "  *kill-session*) rm -f \"$PI_IG_FAKE_TMUX_ALIVE\" ;;",
    "  *kill-server*) rm -f \"$PI_IG_FAKE_TMUX_ALIVE\" ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const previousLog = process.env.PI_IG_FAKE_TMUX_LOG;
  const previousAlive = process.env.PI_IG_FAKE_TMUX_ALIVE;
  process.env.PI_IG_FAKE_TMUX_LOG = logPath;
  process.env.PI_IG_FAKE_TMUX_ALIVE = alivePath;
  try {
    const started = startMonitor({ repo, runId, expectedBranch: "main", tmuxBin: fakeTmux });
    eq(started.status, "started");
    eq(startMonitor({ repo, runId, expectedBranch: "main", tmuxBin: fakeTmux }).status, "already_running");
    eq(monitorStatus({ repo, runId, tmuxBin: fakeTmux }).status, "running");

    const layout = monitorLayout(repo, runId);
    const owner = JSON.parse(fs.readFileSync(layout.activeMarker, "utf8"));
    fs.writeFileSync(layout.activeMarker, `${JSON.stringify({ ...owner, sessionName: "foreign-session" }, null, 2)}\n`);
    throws(() => stopMonitor({ repo, runId, tmuxBin: fakeTmux }), /ownership tmux session mismatch/);
    ok(fs.existsSync(alivePath), "foreign/tampered ownership is not killed");
    fs.writeFileSync(layout.activeMarker, `${JSON.stringify(owner, null, 2)}\n`);
    eq(stopMonitor({ repo, runId, ownerToken: owner.ownerToken, tmuxBin: fakeTmux }).status, "stopped");
    ok(!fs.existsSync(layout.activeMarker));
    ok(!fs.existsSync(alivePath));

    const calls = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/);
    ok(calls.length >= 5);
    ok(calls.every((line) => line.startsWith(`-S ${layout.socketPath} `)), "no call can reach default tmux");
    eq(calls.filter((line) => line.includes("new-session")).length, 1, "idempotent start creates one daemon session");
    eq(calls.filter((line) => line.includes("kill-session")).length, 1, "cleanup kills only the exact owned session");
    eq(calls.filter((line) => line.includes("kill-server")).length, 1, "cleanup terminates only the run-private tmux server");
  } finally {
    if (previousLog === undefined) delete process.env.PI_IG_FAKE_TMUX_LOG;
    else process.env.PI_IG_FAKE_TMUX_LOG = previousLog;
    if (previousAlive === undefined) delete process.env.PI_IG_FAKE_TMUX_ALIVE;
    else process.env.PI_IG_FAKE_TMUX_ALIVE = previousAlive;
  }
  console.log("✓ private tmux monitor start/stop is idempotent, exact-owned, and never contacts default tmux");
}

console.log("\nLong-session lifecycle tests passed. ✓");
