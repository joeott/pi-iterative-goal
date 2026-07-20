import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";

interface SupervisorRequest {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  pidFile: string;
  sandboxIdentity?: MacSandboxIdentity;
}

interface MacSandboxIdentity {
  censusExecutable: string;
  allowedPath: string;
  deniedPath: string;
}

interface ProcessContainment {
  isolatedProcessGroup: true;
  descendantsTerminated: boolean;
  cleanupSignal: "SIGTERM" | "SIGKILL" | null;
  identityCensus: "macos-sandbox-check-v1" | "linux-pid-namespace-v1";
  identityMatchesObserved: number;
}

interface SupervisorOutcome {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: { code?: string; message: string } | null;
  processContainment: ProcessContainment;
}

let activeProcessGroup: number | null = null;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (pathError(error, "ESRCH")) return false;
    return true;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(remaining, 25));
  }
  return true;
}

async function terminateProcessGroup(processGroupId: number | null): Promise<ProcessContainment> {
  const identityCensus = process.platform === "darwin" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1";
  if (!Number.isSafeInteger(processGroupId) || (processGroupId ?? 0) <= 1) {
    return { isolatedProcessGroup: true, descendantsTerminated: false, cleanupSignal: null, identityCensus, identityMatchesObserved: 0 };
  }
  const groupId = processGroupId!;
  if (!processGroupExists(groupId)) {
    return { isolatedProcessGroup: true, descendantsTerminated: true, cleanupSignal: null, identityCensus, identityMatchesObserved: 0 };
  }

  let cleanupSignal: "SIGTERM" | "SIGKILL" = "SIGTERM";
  try { process.kill(-groupId, "SIGTERM"); } catch (error) {
    if (!pathError(error, "ESRCH")) {
      return { isolatedProcessGroup: true, descendantsTerminated: false, cleanupSignal, identityCensus, identityMatchesObserved: 0 };
    }
  }
  if (await waitForProcessGroupExit(groupId, 250)) {
    return { isolatedProcessGroup: true, descendantsTerminated: true, cleanupSignal, identityCensus, identityMatchesObserved: 0 };
  }

  cleanupSignal = "SIGKILL";
  try { process.kill(-groupId, "SIGKILL"); } catch (error) {
    if (!pathError(error, "ESRCH")) {
      return { isolatedProcessGroup: true, descendantsTerminated: false, cleanupSignal, identityCensus, identityMatchesObserved: 0 };
    }
  }
  return {
    isolatedProcessGroup: true,
    descendantsTerminated: await waitForProcessGroupExit(groupId, 2_000),
    cleanupSignal,
    identityCensus,
    identityMatchesObserved: 0,
  };
}

function runSandboxCensus(identity: MacSandboxIdentity, action: "list" | "stop" | "kill"): number[] {
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

function samePidSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((pid) => rightSet.has(pid));
}

async function terminateSandboxIdentity(identity: MacSandboxIdentity): Promise<ProcessContainment> {
  const observed = new Set<number>();
  let previous: number[] = [];
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
  if (!stable) {
    return {
      isolatedProcessGroup: true,
      descendantsTerminated: false,
      cleanupSignal: observed.size > 0 ? "SIGKILL" : null,
      identityCensus: "macos-sandbox-check-v1",
      identityMatchesObserved: observed.size,
    };
  }
  runSandboxCensus(identity, "kill").forEach((pid) => observed.add(pid));
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const remaining = runSandboxCensus(identity, "list");
    if (remaining.length === 0) {
      return {
        isolatedProcessGroup: true,
        descendantsTerminated: true,
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
    descendantsTerminated: runSandboxCensus(identity, "list").length === 0,
    cleanupSignal: observed.size > 0 ? "SIGKILL" : null,
    identityCensus: "macos-sandbox-check-v1",
    identityMatchesObserved: observed.size,
  };
}

function emergencyCleanupAndExit(signal: NodeJS.Signals): never {
  if (activeProcessGroup !== null) {
    try { process.kill(-activeProcessGroup, "SIGKILL"); } catch { /* best effort before exit */ }
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => emergencyCleanupAndExit("SIGINT"));
process.once("SIGTERM", () => emergencyCleanupAndExit("SIGTERM"));

function readRequest(): SupervisorRequest {
  const bytes = fs.readFileSync(0, "utf8");
  const request = JSON.parse(bytes) as Partial<SupervisorRequest>;
  if (typeof request.executable !== "string"
    || !Array.isArray(request.argv)
    || !request.argv.every((item) => typeof item === "string")
    || typeof request.cwd !== "string"
    || !request.env || typeof request.env !== "object"
    || !Number.isSafeInteger(request.timeoutMs) || (request.timeoutMs ?? 0) <= 0
    || !Number.isSafeInteger(request.maxBufferBytes) || (request.maxBufferBytes ?? 0) <= 0
    || typeof request.pidFile !== "string") {
    throw new Error("invalid trusted process supervisor request");
  }
  return request as SupervisorRequest;
}

function writePidFile(filePath: string, pid: number): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${pid}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function boundedCollector(child: ChildProcessWithoutNullStreams, limit: number): {
  stdout: () => string;
  stderr: () => string;
  overflow: Promise<void>;
} {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  let resolveOverflow!: () => void;
  const overflow = new Promise<void>((resolve) => { resolveOverflow = resolve; });
  const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
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

async function run(request: SupervisorRequest): Promise<SupervisorOutcome> {
  const child = spawn(request.executable, request.argv, {
    cwd: request.cwd,
    shell: false,
    detached: true,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const collector = boundedCollector(child, request.maxBufferBytes);
  // Register exit/error listeners synchronously with spawn construction. A
  // one-shot command can otherwise exit before listeners are installed.
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const spawnReady = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // Node exposes the detached child's PID synchronously on successful launch.
  // Publish it before awaiting `spawn`, so termination during that event
  // window still leaves the parent a protected process-group handle.
  if (Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 1) {
    activeProcessGroup = child.pid!;
    writePidFile(request.pidFile, activeProcessGroup);
  }
  try {
    await spawnReady;
  } catch (error) {
    const groupCleanup = await terminateProcessGroup(activeProcessGroup);
    const identityCleanup = request.sandboxIdentity
      ? await terminateSandboxIdentity(request.sandboxIdentity)
      : { ...groupCleanup, descendantsTerminated: true, identityCensus: "linux-pid-namespace-v1" as const, identityMatchesObserved: 0 };
    const message = error instanceof Error ? error.message : String(error);
    return {
      pid: activeProcessGroup ?? undefined,
      status: null,
      signal: null,
      stdout: collector.stdout(),
      stderr: collector.stderr(),
      error: { code: error instanceof Error && "code" in error ? String(error.code) : "ESPAWN", message },
      processContainment: {
        isolatedProcessGroup: true,
        descendantsTerminated: groupCleanup.descendantsTerminated && identityCleanup.descendantsTerminated,
        cleanupSignal: identityCleanup.cleanupSignal ?? groupCleanup.cleanupSignal,
        identityCensus: identityCleanup.identityCensus,
        identityMatchesObserved: identityCleanup.identityMatchesObserved,
      },
    };
  }

  if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 1) {
    return {
      status: null,
      signal: null,
      stdout: collector.stdout(),
      stderr: collector.stderr(),
      error: { code: "ESPAWNPID", message: "sandbox launcher did not expose a valid process-group id" },
      processContainment: { isolatedProcessGroup: true, descendantsTerminated: false, cleanupSignal: null, identityCensus: process.platform === "darwin" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1", identityMatchesObserved: 0 },
    };
  }
  if (activeProcessGroup === null) {
    activeProcessGroup = child.pid!;
    writePidFile(request.pidFile, activeProcessGroup);
  }

  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), request.timeoutMs);
  });
  const completion = await Promise.race([
    exit.then((value) => ({ kind: "exit" as const, value })),
    timeout.then(() => ({ kind: "timeout" as const })),
    collector.overflow.then(() => ({ kind: "overflow" as const })),
  ]);

  let direct = completion.kind === "exit" ? completion.value : { code: null, signal: null };
  let error: SupervisorOutcome["error"] = null;
  if (completion.kind === "timeout") {
    error = { code: "ETIMEDOUT", message: `sandboxed process exceeded ${request.timeoutMs}ms` };
  } else if (completion.kind === "overflow") {
    error = { code: "ENOBUFS", message: `sandboxed process exceeded ${request.maxBufferBytes} output bytes` };
  }

  const groupCleanup = await terminateProcessGroup(activeProcessGroup);
  const identityCleanup = request.sandboxIdentity
    ? await terminateSandboxIdentity(request.sandboxIdentity)
    : {
      isolatedProcessGroup: true as const,
      descendantsTerminated: true,
      cleanupSignal: null,
      identityCensus: "linux-pid-namespace-v1" as const,
      identityMatchesObserved: 0,
    };
  const processContainment: ProcessContainment = {
    isolatedProcessGroup: true,
    descendantsTerminated: groupCleanup.descendantsTerminated && identityCleanup.descendantsTerminated,
    cleanupSignal: identityCleanup.cleanupSignal ?? groupCleanup.cleanupSignal,
    identityCensus: identityCleanup.identityCensus,
    identityMatchesObserved: identityCleanup.identityMatchesObserved,
  };
  if (completion.kind !== "exit") {
    direct = await Promise.race([
      exit,
      new Promise<typeof direct>((resolve) => setTimeout(() => resolve(direct), 2_000)),
    ]);
  }
  if (timer) clearTimeout(timer);
  activeProcessGroup = null;
  return {
    pid: child.pid,
    status: direct.code,
    signal: direct.signal,
    stdout: collector.stdout(),
    stderr: collector.stderr(),
    error,
    processContainment,
  };
}

try {
  const outcome = await run(readRequest());
  process.stdout.write(JSON.stringify(outcome));
} catch (error) {
  if (activeProcessGroup !== null) await terminateProcessGroup(activeProcessGroup);
  const message = error instanceof Error ? error.message : String(error);
  const outcome: SupervisorOutcome = {
    status: null,
    signal: null,
    stdout: "",
    stderr: message,
    error: { code: "ESUPERVISOR", message },
    processContainment: { isolatedProcessGroup: true, descendantsTerminated: false, cleanupSignal: null, identityCensus: process.platform === "darwin" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1", identityMatchesObserved: 0 },
  };
  process.stdout.write(JSON.stringify(outcome));
  process.exitCode = 1;
}
