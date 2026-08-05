#!/usr/bin/env node

/**
 * Standalone trusted child-process supervisor.
 *
 * This file is a deliberately dependency-free trust anchor. The verifier
 * authenticates its exact bytes against a baked SHA-256, copies those bytes to
 * a fresh private attempt directory, and executes only that private copy.
 * Keep it standalone: imports from the project would reintroduce mutable
 * runtime dependencies outside the authenticated blob.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function runSandboxCensus(identity, action) {
  const output = execFileSync(identity.censusExecutable, [identity.allowedPath, identity.deniedPath, action], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  return [...new Set(output.split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1))];
}

function samePidSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((pid) => rightSet.has(pid));
}

async function terminateSandboxIdentity(identity) {
  const observed = new Set();
  let previous = [];
  let stable = false;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const stopped = runSandboxCensus(identity, "stop");
    stopped.forEach((pid) => observed.add(pid));
    if (samePidSet(stopped, previous)) {
      stable = true;
      break;
    }
    previous = stopped;
    await sleep(5);
  }

  // Even a fork storm must not strand processes that this helper already
  // stopped. Continue through the identity-checked kill path; `stable` is
  // retained only as a containment-quality signal.
  runSandboxCensus(identity, "kill").forEach((pid) => observed.add(pid));
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const remaining = runSandboxCensus(identity, "list");
    if (remaining.length === 0) {
      return {
        isolatedProcessGroup: true,
        descendantsTerminated: stable,
        cleanupSignal: observed.size > 0 ? "SIGKILL" : null,
        identityCensus: "macos-sandbox-check-v1",
        identityMatchesObserved: observed.size,
      };
    }
    runSandboxCensus(identity, "stop").forEach((pid) => observed.add(pid));
    runSandboxCensus(identity, "kill").forEach((pid) => observed.add(pid));
    await sleep(25);
  }
  return {
    isolatedProcessGroup: true,
    descendantsTerminated: false,
    cleanupSignal: observed.size > 0 ? "SIGKILL" : null,
    identityCensus: "macos-sandbox-check-v1",
    identityMatchesObserved: observed.size,
  };
}

function emergencyCleanupAndExit(signal) {
  // Never signal the sandbox launcher's raw PID. The verifier owns this
  // helper's detached process group from spawnSync's direct-child result and
  // performs the authoritative TERM/KILL + extinction check after we exit.
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => emergencyCleanupAndExit("SIGINT"));
process.once("SIGTERM", () => emergencyCleanupAndExit("SIGTERM"));

function readRequest() {
  const bytes = fs.readFileSync(0, "utf8");
  const request = JSON.parse(bytes);
  const identity = request.sandboxIdentity;
  const identityValid = identity === undefined || (identity
    && typeof identity === "object"
    && typeof identity.censusExecutable === "string"
    && typeof identity.allowedPath === "string"
    && typeof identity.deniedPath === "string");
  if (typeof request.executable !== "string"
    || !Array.isArray(request.argv)
    || !request.argv.every((item) => typeof item === "string")
    || typeof request.cwd !== "string"
    || !request.env || typeof request.env !== "object"
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0
    || !Number.isSafeInteger(request.maxBufferBytes) || request.maxBufferBytes <= 0
    || typeof request.requestNonce !== "string" || !/^[a-f0-9]{64}$/.test(request.requestNonce)
    || !identityValid) {
    throw new Error("invalid trusted process supervisor request");
  }
  return request;
}

function boundedCollector(child, limit) {
  const stdout = [];
  const stderr = [];
  let total = 0;
  let overflowed = false;
  let resolveOverflow;
  const overflow = new Promise((resolve) => { resolveOverflow = resolve; });
  const collect = (target) => (chunk) => {
    if (overflowed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) {
      overflowed = true;
      resolveOverflow();
      return;
    }
    target.push(bytes);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  return {
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stderr: () => Buffer.concat(stderr).toString("utf8"),
    overflow,
  };
}

async function run(request) {
  // The parent launches this authenticated helper as a detached process-group
  // leader and owns that PGID directly. The sandbox launcher deliberately stays
  // in our group, so no helper-controlled PID is ever accepted as kill authority.
  const child = spawn(request.executable, request.argv, {
    cwd: request.cwd,
    shell: false,
    detached: false,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const collector = boundedCollector(child, request.maxBufferBytes);
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const spawnReady = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    await spawnReady;
  } catch (error) {
    const identityCleanup = request.sandboxIdentity
      ? await terminateSandboxIdentity(request.sandboxIdentity)
      : {
        isolatedProcessGroup: true,
        descendantsTerminated: true,
        cleanupSignal: null,
        identityCensus: "linux-pid-namespace-v1",
        identityMatchesObserved: 0,
      };
    const message = error instanceof Error ? error.message : String(error);
    return {
      supervisorPid: process.pid,
      requestNonce: request.requestNonce,
      status: null,
      signal: null,
      stdout: collector.stdout(),
      stderr: collector.stderr(),
      error: { code: error instanceof Error && "code" in error ? String(error.code) : "ESPAWN", message },
      processContainment: identityCleanup,
    };
  }

  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    return {
      supervisorPid: process.pid,
      requestNonce: request.requestNonce,
      status: null,
      signal: null,
      stdout: collector.stdout(),
      stderr: collector.stderr(),
      error: { code: "ESPAWNPID", message: "sandbox launcher did not expose a valid child pid" },
      processContainment: {
        isolatedProcessGroup: true,
        descendantsTerminated: false,
        cleanupSignal: null,
        identityCensus: process.platform === "darwin" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1",
        identityMatchesObserved: 0,
      },
    };
  }

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), request.timeoutMs);
  });
  const completion = await Promise.race([
    exit.then((value) => ({ kind: "exit", value })),
    timeout.then(() => ({ kind: "timeout" })),
    collector.overflow.then(() => ({ kind: "overflow" })),
  ]);

  const direct = completion.kind === "exit" ? completion.value : { code: null, signal: null };
  let error = null;
  if (completion.kind === "timeout") {
    error = { code: "ETIMEDOUT", message: `sandboxed process exceeded ${request.timeoutMs}ms` };
  } else if (completion.kind === "overflow") {
    error = { code: "ENOBUFS", message: `sandboxed process exceeded ${request.maxBufferBytes} output bytes` };
  }

  const identityCleanup = request.sandboxIdentity
    ? await terminateSandboxIdentity(request.sandboxIdentity)
    : {
      isolatedProcessGroup: true,
      descendantsTerminated: true,
      cleanupSignal: null,
      identityCensus: "linux-pid-namespace-v1",
      identityMatchesObserved: 0,
    };
  if (timer) clearTimeout(timer);
  return {
    supervisorPid: process.pid,
    requestNonce: request.requestNonce,
    status: direct.code,
    signal: direct.signal,
    stdout: collector.stdout(),
    stderr: collector.stderr(),
    error,
    processContainment: {
      ...identityCleanup,
      // On timeout/overflow the helper deliberately leaves its direct child in
      // the authenticated helper group. The parent can then terminate that
      // group without accepting any helper-reported or reused child PID.
      descendantsTerminated: completion.kind === "exit" && identityCleanup.descendantsTerminated,
    },
  };
}

let requestNonce = null;
try {
  const request = readRequest();
  requestNonce = request.requestNonce;
  const outcome = await run(request);
  fs.writeSync(1, JSON.stringify(outcome));
  // A timed-out child intentionally remains in our detached group. Exit
  // synchronously after publishing the bounded response so spawnSync returns
  // to the parent, which owns and extinguishes that group.
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fs.writeSync(1, JSON.stringify({
    supervisorPid: process.pid,
    requestNonce,
    status: null,
    signal: null,
    stdout: "",
    stderr: message,
    error: { code: "ESUPERVISOR", message },
    processContainment: {
      isolatedProcessGroup: true,
      descendantsTerminated: false,
      cleanupSignal: null,
      identityCensus: process.platform === "darwin" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1",
      identityMatchesObserved: 0,
    },
  }));
  // The parent still owns group cleanup when supervisor execution itself
  // fails, so do not guess at or signal a raw child PID here.
  process.exit(1);
}
