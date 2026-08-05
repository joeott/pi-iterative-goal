#!/usr/bin/env node
/**
 * Run OFF plus the four dependency-valid cumulative feature profiles through
 * the real Pi RPC confirmation harness. Every driver is a dedicated POSIX
 * process-group leader so timeout/interruption cleanup can target only the
 * exact descendants owned by this matrix run.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_FEATURE_PROFILES,
  featureProfileBudget,
  featureProfileDepth,
} from "./lib/prod-feature-matrix.mjs";
import {
  assertRuntimeProvenanceUnchanged,
  captureRuntimeProvenance,
} from "./lib/runtime-provenance.mjs";
import { readOsProcessIdentity } from "../dist/agents/pool.js";

if (process.platform === "win32") {
  throw new Error("production feature matrix requires POSIX process-group ownership");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "dist", "pi-iterative-goal.js");
const piPath = path.join(repoRoot, "node_modules", ".bin", "pi");
const PRODUCTION_SUITE_MAX_MODEL_RESPONSES = 240;
const PRODUCTION_SUITE_MAX_MODEL_TOKENS = 1_500_000;
const MAX_CONFIRMATION_DIRECTORIES = 20_000;
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_SCAN_BYTES = 256 * 1024 * 1024;
const EXPECTED_PROFILES = Object.freeze([
  "off",
  "c1",
  "c1-c2",
  "c1-c2-c3",
  "c1-c2-c3-c4",
]);
const EXPECTED_PROFILE_BUDGETS = Object.freeze({
  off: Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  c1: Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  "c1-c2": Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  "c1-c2-c3": Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  "c1-c2-c3-c4": Object.freeze({ maxMinutes: 20, maxModelResponses: 60, maxTokens: 500_000 }),
});

if (process.argv.length === 3 && process.argv[2] === "--self-test-owned-group") {
  runOwnedGroupSelfTest();
  console.log("prod-feature-matrix owned-group identity: PASS");
  process.exit(0);
}

if (JSON.stringify(PRODUCTION_FEATURE_PROFILES) !== JSON.stringify(EXPECTED_PROFILES)) {
  throw new Error("production feature profile set/order differs from the exact certification contract");
}
for (const profile of EXPECTED_PROFILES) {
  if (JSON.stringify(featureProfileBudget(profile)) !== JSON.stringify(EXPECTED_PROFILE_BUDGETS[profile])) {
    throw new Error(`production feature budget differs from the exact contract for ${profile}`);
  }
}
const opts = {
  maxMinutesPerProfile: 20,
  maxModelCallsPerProfile: 60,
  keepTemp: false,
};
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--max-minutes-per-profile" && process.argv[index + 1]) {
    opts.maxMinutesPerProfile = Number(process.argv[++index]);
  } else if (arg === "--max-model-calls-per-profile" && process.argv[index + 1]) {
    opts.maxModelCallsPerProfile = Number(process.argv[++index]);
  } else if (arg === "--keep-temp") {
    opts.keepTemp = true;
  } else {
    throw new Error(`unknown or incomplete option: ${arg}`);
  }
}
if (!Number.isFinite(opts.maxMinutesPerProfile) || opts.maxMinutesPerProfile <= 0 || opts.maxMinutesPerProfile > 20) {
  throw new Error("--max-minutes-per-profile must be greater than 0 and at most 20");
}
if (!Number.isSafeInteger(opts.maxModelCallsPerProfile)
  || opts.maxModelCallsPerProfile < 1
  || opts.maxModelCallsPerProfile > 60) {
  throw new Error("--max-model-calls-per-profile must be an integer from 1 through 60");
}
const effectiveProfileBudgets = Object.fromEntries(PRODUCTION_FEATURE_PROFILES.map((profile) => {
  const contract = featureProfileBudget(profile);
  return [profile, {
    maxMinutes: Math.min(contract.maxMinutes, opts.maxMinutesPerProfile),
    maxModelResponses: Math.min(contract.maxModelResponses, opts.maxModelCallsPerProfile),
    maxTokens: contract.maxTokens,
  }];
}));
const aggregateModelCallCeiling = Object.values(effectiveProfileBudgets)
  .reduce((sum, budget) => sum + budget.maxModelResponses, 0);
const aggregateModelTokenCeiling = Object.values(effectiveProfileBudgets)
  .reduce((sum, budget) => sum + budget.maxTokens, 0);
if (!Number.isSafeInteger(aggregateModelCallCeiling)
  || aggregateModelCallCeiling < 1
  || aggregateModelCallCeiling > PRODUCTION_SUITE_MAX_MODEL_RESPONSES) {
  throw new Error(`effective profile budgets exceed the ${PRODUCTION_SUITE_MAX_MODEL_RESPONSES}-response suite ceiling`);
}
if (!Number.isSafeInteger(aggregateModelTokenCeiling)
  || aggregateModelTokenCeiling < 1
  || aggregateModelTokenCeiling > PRODUCTION_SUITE_MAX_MODEL_TOKENS) {
  throw new Error(`effective profile budgets exceed the ${PRODUCTION_SUITE_MAX_MODEL_TOKENS}-token suite ceiling`);
}
const runtimeProvenance = captureRuntimeProvenance(repoRoot, { extensionPath, piPath });
if (runtimeProvenance.build?.status !== "PASS"
  || !/^[a-f0-9]{40}$/.test(runtimeProvenance.headSha)
  || !/^[a-f0-9]{40}$/.test(runtimeProvenance.treeSha)) {
  throw new Error("initial clean committed HEAD/tree/fresh-build provenance is incomplete");
}
const runtimeProvenanceDigest = crypto.createHash("sha256")
  .update(JSON.stringify(runtimeProvenance))
  .digest("hex");
const { runManagedLogRetention } = await import("../dist/log-retention.js");
const initialSourceRetention = runManagedLogRetention(repoRoot);
if (initialSourceRetention.blocked) {
  throw new Error(`source managed-log retention is blocked: ${initialSourceRetention.reasons.join("; ")}`);
}

const startedAt = new Date().toISOString();
const matrixId = `feature-matrix-${startedAt.replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
const confirmationRoot = path.join(repoRoot, ".pi", "iterative-goal", "managed", "evidence", "prod-runtime-confirmation");
const matrixDir = path.join(repoRoot, ".pi", "iterative-goal", "managed", "evidence", "prod-feature-matrix", matrixId);
fs.mkdirSync(matrixDir, { recursive: true, mode: 0o700 });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBoundedReceiptNoFollow(candidate, maximumBytes = MAX_RECEIPT_BYTES) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is unavailable; receipt reads cannot be trusted");
  }
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error(`receipt is not a bounded regular file: ${candidate}`);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    const overflowBytes = fs.readSync(descriptor, overflow, 0, 1, null);
    const after = fs.fstatSync(descriptor);
    if (offset !== before.size || overflowBytes !== 0
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`receipt changed during bounded read: ${candidate}`);
    }
    const body = bytes.toString("utf8");
    return {
      path: candidate,
      bytes: before.size,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      parsed: JSON.parse(body),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function scanMatrixReceipts() {
  const byProfile = new Map();
  let scannedBytes = 0;
  if (!fs.existsSync(confirmationRoot)) return byProfile;
  const rootStat = fs.lstatSync(confirmationRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("production confirmation root is not a trusted directory");
  }
  const canonicalRoot = fs.realpathSync(confirmationRoot);
  const names = fs.readdirSync(canonicalRoot).sort();
  if (names.length > MAX_CONFIRMATION_DIRECTORIES) {
    throw new Error(`production confirmation root exceeds ${MAX_CONFIRMATION_DIRECTORIES} entries`);
  }
  for (const name of names) {
    const directory = path.join(canonicalRoot, name);
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink()) throw new Error(`confirmation directory is a symlink: ${name}`);
    if (!directoryStat.isDirectory()) continue;
    if (fs.realpathSync(directory) !== directory) {
      throw new Error(`confirmation directory is not canonical: ${name}`);
    }
    const candidate = path.join(directory, "results.json");
    let receipt;
    try {
      const remainingBytes = MAX_RECEIPT_SCAN_BYTES - scannedBytes;
      if (remainingBytes <= 0) throw new Error(`production receipt scan exceeds ${MAX_RECEIPT_SCAN_BYTES} bytes`);
      receipt = readBoundedReceiptNoFollow(candidate, Math.min(MAX_RECEIPT_BYTES, remainingBytes));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    scannedBytes += receipt.bytes;
    if (scannedBytes > MAX_RECEIPT_SCAN_BYTES) {
      throw new Error(`production receipt scan exceeds ${MAX_RECEIPT_SCAN_BYTES} bytes`);
    }
    if (receipt.parsed?.featureMatrixId !== matrixId) continue;
    const profile = receipt.parsed?.featureProfile;
    if (!EXPECTED_PROFILES.includes(profile)) {
      throw new Error(`extra receipt has an unrecognized feature profile: ${String(profile)}`);
    }
    if (byProfile.has(profile)) {
      throw new Error(`duplicate receipt for production feature profile: ${profile}`);
    }
    byProfile.set(profile, receipt);
  }
  return byProfile;
}

function assertReceiptBoundToInitialProvenance(profile, receipt) {
  const parsed = receipt?.parsed;
  const budget = effectiveProfileBudgets[profile];
  const sourceProof = parsed?.featureEvidence?.sourceProof;
  if (!parsed || parsed.featureMatrixId !== matrixId || parsed.featureProfile !== profile) {
    throw new Error(`receipt identity mismatch for ${profile}`);
  }
  if (parsed.gitSha !== runtimeProvenance.headSha
    || parsed.runtimeProvenanceDigest !== runtimeProvenanceDigest
    || JSON.stringify(parsed.runtimeProvenance) !== JSON.stringify(runtimeProvenance)
    || parsed.runtimeProvenanceStatus !== "PASS"
    || parsed.runtimeProvenanceViolation !== null) {
    throw new Error(`receipt runtime provenance mismatch for ${profile}`);
  }
  if (sourceProof?.headSha !== runtimeProvenance.headSha
    || sourceProof?.treeSha !== runtimeProvenance.treeSha
    || sourceProof?.extensionSha256 !== runtimeProvenance.extension.sha256
    || sourceProof?.runtimeProvenanceDigest !== runtimeProvenanceDigest) {
    throw new Error(`receipt source proof mismatch for ${profile}`);
  }
  if (parsed.featureEvidence?.featureMatrixId !== matrixId
    || parsed.featureEvidence?.profile !== profile) {
    throw new Error(`feature evidence identity mismatch for ${profile}`);
  }
  const observed = parsed.modelCallBudget?.observed;
  if (parsed.modelCallBudget?.ceiling !== budget.maxModelResponses
    || parsed.modelCallBudget?.status !== "PASS"
    || !Number.isSafeInteger(observed)
    || observed < 0
    || observed > budget.maxModelResponses) {
    throw new Error(`receipt model-response budget mismatch for ${profile}`);
  }
  const observedTokens = parsed.tokenBudget?.observed;
  if (parsed.tokenBudget?.ceiling !== budget.maxTokens
    || parsed.tokenBudget?.status !== "PASS"
    || parsed.tokenBudget?.usageComplete !== true
    || !Number.isSafeInteger(observedTokens)
    || observedTokens < 0
    || observedTokens > budget.maxTokens) {
    throw new Error(`receipt model-token budget mismatch for ${profile}`);
  }
  if (parsed.counters?.judgeVerdicts !== 0) {
    throw new Error(`feature-boundary receipt unexpectedly executed a judge for ${profile}`);
  }
  const depth = featureProfileDepth(profile);
  const expectedTools = [
    "goal_repo_context",
    "goal_report_phase_result",
    "goal_update_task_plan",
    ...(depth >= 1 ? ["goal_subagent"] : []),
    ...(depth >= 2 ? ["goal_post_shards"] : []),
  ];
  if (parsed.featureToolSurface?.status !== "PASS"
    || JSON.stringify(parsed.featureToolSurface?.allowed) !== JSON.stringify(expectedTools)
    || !Array.isArray(parsed.featureToolSurface?.unexpected)
    || parsed.featureToolSurface.unexpected.length !== 0) {
    throw new Error(`receipt feature-tool surface mismatch for ${profile}`);
  }
  if (profile === "off") {
    if (parsed.featureEvidence?.judgeConfiguration !== null) {
      throw new Error("off profile unexpectedly claims a judge configuration");
    }
  } else if (parsed.featureEvidence?.judgeConfiguration?.executionStatus !== "NOT_EXECUTED_IN_FEATURE_BOUNDARY_RUN") {
    throw new Error(`receipt obscures the unexecuted judge boundary for ${profile}`);
  }
  return { responses: observed, tokens: observedTokens };
}

function safeReadDriverIdentity(pid, readIdentity = readOsProcessIdentity) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const identity = readIdentity(pid);
    if (identity === null
      || identity.pid !== pid
      || !Number.isSafeInteger(identity.parentPid)
      || identity.parentPid <= 0
      || !Number.isSafeInteger(identity.processGroupId)
      || identity.processGroupId <= 0
      || typeof identity.startToken !== "string"
      || identity.startToken.length === 0) return null;
    return identity;
  } catch {
    return null;
  }
}

function captureOwnedGroup(child, readIdentity = readOsProcessIdentity) {
  const pid = child && Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
  const observed = pid === null ? null : safeReadDriverIdentity(pid, readIdentity);
  const identity = observed !== null
    && observed.parentPid === process.pid
    && observed.processGroupId === pid
    ? observed
    : null;
  return {
    child,
    pid,
    identity,
    initialStatus: identity === null ? "UNVERIFIED" : "VERIFIED",
    status: identity === null ? "identity_unavailable_at_spawn" : "verified",
    ownershipRevoked: identity === null,
  };
}

function attestOwnedGroup(ownership, readIdentity = readOsProcessIdentity) {
  if (!ownership || ownership.ownershipRevoked || ownership.identity === null || ownership.pid === null) return null;
  const current = safeReadDriverIdentity(ownership.pid, readIdentity);
  const expected = ownership.identity;
  if (current === null
    || current.pid !== expected.pid
    || current.parentPid !== expected.parentPid
    || current.processGroupId !== expected.processGroupId
    || current.processGroupId !== ownership.pid
    || current.startToken !== expected.startToken) {
    // Sticky revocation prevents a later PID wrap from ever re-authorizing this
    // ownership record, even if a crafted identity happens to resemble it.
    ownership.ownershipRevoked = true;
    ownership.status = current === null ? "identity_unavailable" : "identity_mismatch";
    return null;
  }
  ownership.status = "verified";
  return current;
}

function processErrorCode(error, code) {
  return error && typeof error === "object" && error.code === code;
}

function observeOwnedGroup(ownership, {
  readIdentity = readOsProcessIdentity,
  probeGroup = (processGroupId) => process.kill(-processGroupId, 0),
} = {}) {
  if (ownership?.child
    && (ownership.child.exitCode !== null || ownership.child.signalCode !== null)) {
    return observeClosedOwnedGroupExtinction(ownership, { probeGroup });
  }
  const identity = attestOwnedGroup(ownership, readIdentity);
  if (identity === null) return { alive: null, status: ownership?.status ?? "ownership_missing" };
  try {
    probeGroup(identity.processGroupId);
    return { alive: true, status: "verified_alive" };
  } catch (error) {
    if (processErrorCode(error, "EPERM")) return { alive: true, status: "verified_alive_no_permission" };
    ownership.ownershipRevoked = true;
    if (processErrorCode(error, "ESRCH")) {
      ownership.status = "verified_group_gone";
      return { alive: false, status: ownership.status };
    }
    ownership.status = "group_probe_failed";
    return { alive: null, status: ownership.status };
  }
}

/**
 * Once the driver has closed its birth identity can no longer be re-read. At
 * that point the only certifying observation is the kernel reporting ESRCH for
 * the exact captured process-group id. A present group or an indeterminate
 * probe is never converted into cleanup success, and this path never signals
 * an identity that can no longer be attested.
 */
function observeClosedOwnedGroupExtinction(ownership, {
  probeGroup = (processGroupId) => process.kill(-processGroupId, 0),
} = {}) {
  const processGroupId = ownership?.pid ?? null;
  const child = ownership?.child ?? null;
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    return { alive: null, status: "post_close_group_id_unavailable" };
  }
  if (!child || (child.exitCode === null && child.signalCode === null)) {
    return { alive: null, status: "driver_close_unconfirmed" };
  }
  // The leader is closed, so this ownership record can never authorize a
  // later signal. The read-only group probe below can only prove extinction.
  ownership.ownershipRevoked = true;
  try {
    probeGroup(processGroupId);
    ownership.status = "post_close_group_present";
    return { alive: true, status: ownership.status };
  } catch (error) {
    if (processErrorCode(error, "ESRCH")) {
      ownership.status = "post_close_group_extinct";
      return { alive: false, status: ownership.status };
    }
    if (processErrorCode(error, "EPERM")) {
      ownership.status = "post_close_group_present_no_permission";
      return { alive: true, status: ownership.status };
    }
    ownership.status = "post_close_group_probe_indeterminate";
    return { alive: null, status: ownership.status };
  }
}

function signalOwnedGroup(ownership, signal, {
  readIdentity = readOsProcessIdentity,
  killGroup = (processGroupId, requestedSignal) => process.kill(-processGroupId, requestedSignal),
} = {}) {
  const identity = attestOwnedGroup(ownership, readIdentity);
  if (identity === null) return { sent: false, status: ownership?.status ?? "ownership_missing" };
  try {
    killGroup(identity.processGroupId, signal);
    return { sent: true, status: "verified_signal_sent" };
  } catch (error) {
    ownership.ownershipRevoked = true;
    ownership.status = processErrorCode(error, "ESRCH") ? "verified_group_gone" : "group_signal_failed";
    return { sent: false, status: ownership.status };
  }
}

function signalOwnedDriver(ownership, signal, {
  readIdentity = readOsProcessIdentity,
  killDriver = (child, requestedSignal) => child.kill(requestedSignal),
} = {}) {
  const identity = attestOwnedGroup(ownership, readIdentity);
  if (identity === null) return { sent: false, status: ownership?.status ?? "ownership_missing" };
  if (ownership.child?.exitCode !== null || ownership.child?.signalCode !== null) {
    ownership.ownershipRevoked = true;
    ownership.status = "driver_already_closed";
    return { sent: false, status: ownership.status };
  }
  try {
    const sent = killDriver(ownership.child, signal) === true;
    if (!sent) {
      ownership.ownershipRevoked = true;
      ownership.status = "driver_signal_refused";
    }
    return { sent, status: sent ? "verified_driver_signal_sent" : ownership.status };
  } catch {
    ownership.ownershipRevoked = true;
    ownership.status = "driver_signal_failed";
    return { sent: false, status: ownership.status };
  }
}

async function waitForOwnedGroupExit(ownership, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed = observeOwnedGroup(ownership);
  while (observed.alive === true && Date.now() < deadline) {
    await delay(200);
    observed = observeOwnedGroup(ownership);
  }
  return observed;
}

async function terminateOwnedGroup(ownership, reason) {
  const child = ownership?.child ?? null;
  const pid = ownership?.pid ?? null;
  const cleanup = {
    reason,
    processGroupId: pid,
    termSent: false,
    killSent: false,
    groupAliveAfterCleanup: null,
    ownershipInitialStatus: ownership?.initialStatus ?? "UNVERIFIED",
    ownershipStatus: ownership?.status ?? "ownership_missing",
  };
  if (child?.exitCode === null && child?.signalCode === null) {
    // Signal the driver exactly once. Its handler forwards one graceful signal
    // to Pi, whose session_shutdown path owns the detached worker groups.
    // Group-signalling here would also hit Pi directly and make that a second
    // SIGTERM, which Pi treats as an immediate shutdown bypass.
    const term = signalOwnedDriver(ownership, "SIGTERM");
    cleanup.termSent = term.sent;
    cleanup.ownershipStatus = term.status;
  } else {
    // The driver is already gone but something in its non-worker group remains.
    const term = signalOwnedGroup(ownership, "SIGTERM");
    cleanup.termSent = term.sent;
    cleanup.ownershipStatus = term.status;
  }
  let finalObservation = await waitForOwnedGroupExit(ownership, 20_000);
  if (finalObservation.alive === true) {
    const kill = signalOwnedGroup(ownership, "SIGKILL");
    cleanup.killSent = kill.sent;
    cleanup.ownershipStatus = kill.status;
    finalObservation = await waitForOwnedGroupExit(ownership, 3_000);
  }
  cleanup.groupAliveAfterCleanup = finalObservation.alive;
  cleanup.groupExtinctionConfirmed = finalObservation.alive === false;
  cleanup.ownershipStatus = finalObservation.status;
  return cleanup;
}

function runOwnedGroupSelfTest() {
  const pid = 87_001;
  let current = {
    pid,
    parentPid: process.pid,
    processGroupId: pid,
    startToken: "self-test-boot:100",
  };
  const childSignals = [];
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    kill: (signal) => { childSignals.push(signal); return true; },
  };
  const ownership = captureOwnedGroup(child, () => current);
  if (ownership.initialStatus !== "VERIFIED") throw new Error("self-test failed to capture ownership");
  const driverTerm = signalOwnedDriver(ownership, "SIGTERM", {
    readIdentity: () => current,
    killDriver: (target, signal) => target.kill(signal),
  });
  if (!driverTerm.sent || childSignals.join(",") !== "SIGTERM") {
    throw new Error("self-test rejected a matching driver identity");
  }
  const groupSignals = [];
  const groupTerm = signalOwnedGroup(ownership, "SIGTERM", {
    readIdentity: () => current,
    killGroup: (processGroupId, signal) => groupSignals.push(`${processGroupId}:${signal}`),
  });
  if (!groupTerm.sent || groupSignals.join(",") !== `${pid}:SIGTERM`) {
    throw new Error("self-test rejected a matching group identity");
  }
  current = { ...current, startToken: "self-test-boot:101" };
  const staleKill = signalOwnedGroup(ownership, "SIGKILL", {
    readIdentity: () => current,
    killGroup: (processGroupId, signal) => groupSignals.push(`${processGroupId}:${signal}`),
  });
  if (staleKill.sent || groupSignals.length !== 1 || ownership.status !== "identity_mismatch") {
    throw new Error("self-test signalled a reused PID/PGID");
  }
  current = ownership.identity;
  const stickyRetry = signalOwnedGroup(ownership, "SIGKILL", {
    readIdentity: () => current,
    killGroup: (processGroupId, signal) => groupSignals.push(`${processGroupId}:${signal}`),
  });
  if (stickyRetry.sent || groupSignals.length !== 1) {
    throw new Error("self-test re-authorized a revoked ownership record");
  }

  const closedChild = {
    pid: pid + 1,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  };
  const closedIdentity = {
    pid: closedChild.pid,
    parentPid: process.pid,
    processGroupId: closedChild.pid,
    startToken: "self-test-boot:200",
  };
  const closedOwnership = captureOwnedGroup(closedChild, () => closedIdentity);
  closedChild.exitCode = 0;
  const extinctError = Object.assign(new Error("no such process group"), { code: "ESRCH" });
  const extinct = observeOwnedGroup(closedOwnership, {
    probeGroup: () => { throw extinctError; },
  });
  if (extinct.alive !== false || extinct.status !== "post_close_group_extinct") {
    throw new Error("self-test did not positively prove post-close group extinction");
  }

  const presentChild = { ...closedChild, pid: pid + 2, exitCode: null };
  const presentIdentity = { ...closedIdentity, pid: presentChild.pid, processGroupId: presentChild.pid };
  const presentOwnership = captureOwnedGroup(presentChild, () => presentIdentity);
  presentChild.exitCode = 0;
  const present = observeOwnedGroup(presentOwnership, { probeGroup: () => undefined });
  if (present.alive !== true || present.status !== "post_close_group_present") {
    throw new Error("self-test misclassified a surviving post-close process group");
  }

  const unknownChild = { ...closedChild, pid: pid + 3, exitCode: null };
  const unknownIdentity = { ...closedIdentity, pid: unknownChild.pid, processGroupId: unknownChild.pid };
  const unknownOwnership = captureOwnedGroup(unknownChild, () => unknownIdentity);
  unknownChild.exitCode = 0;
  const unknown = observeOwnedGroup(unknownOwnership, {
    probeGroup: () => { throw Object.assign(new Error("probe failed"), { code: "EIO" }); },
  });
  if (unknown.alive !== null || unknown.status !== "post_close_group_probe_indeterminate") {
    throw new Error("self-test converted indeterminate post-close cleanup into extinction");
  }
}

let activeRun = null;
let interruptedSignal = null;
let resolveInterruption;
const interruption = new Promise((resolve) => { resolveInterruption = resolve; });
function requestMatrixStop(signal) {
  if (interruptedSignal) return;
  interruptedSignal = signal;
  resolveInterruption({ kind: "interrupted", signal });
}
const onSigint = () => requestMatrixStop("SIGINT");
const onSigterm = () => requestMatrixStop("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

async function runProfile(profile) {
  const profileBudget = effectiveProfileBudgets[profile];
  const args = [
    path.join(repoRoot, "scripts", "prod-runtime-confirmation.mjs"),
    "--feature-profile", profile,
    "--max-minutes", String(profileBudget.maxMinutes),
    "--max-model-calls", String(profileBudget.maxModelResponses),
    ...(opts.keepTemp ? ["--keep-temp"] : []),
  ];
  let spawnError = null;
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_PROD_FEATURE_MATRIX_ID: matrixId,
      PI_PROD_FEATURE_MATRIX_PROVENANCE_SHA256: runtimeProvenanceDigest,
    },
    stdio: "inherit",
    shell: false,
    detached: true,
  });
  const ownership = captureOwnedGroup(child);
  if (ownership.initialStatus !== "VERIFIED") {
    spawnError = new Error("driver process-group birth identity could not be verified at spawn");
  }
  const closePromise = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, signal) => resolve({ kind: "closed", exitCode, signal }));
  });
  activeRun = { child, closePromise, ownership, profile };

  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), Math.ceil((profileBudget.maxMinutes + 3) * 60_000));
  });
  const outcome = await Promise.race([closePromise, timeout, interruption]);
  clearTimeout(timeoutId);

  let cleanup = null;
  let closed = outcome;
  let postRunGroup = null;
  if (outcome.kind === "timeout" || outcome.kind === "interrupted") {
    cleanup = await terminateOwnedGroup(ownership, outcome.kind === "timeout" ? "profile_timeout" : outcome.signal);
    closed = await Promise.race([closePromise, delay(1_000).then(() => ({ kind: "cleanup_wait_expired", exitCode: child.exitCode, signal: child.signalCode }))]);
    postRunGroup = { alive: cleanup.groupAliveAfterCleanup, status: cleanup.ownershipStatus };
  } else {
    postRunGroup = observeOwnedGroup(ownership);
  }
  if (outcome.kind === "closed" && postRunGroup.alive === true) {
    // The driver normally waits for its Pi child and pool teardown. A surviving
    // group after driver close is still ours, so clean only that exact group.
    cleanup = await terminateOwnedGroup(ownership, "descendant_survived_driver");
    postRunGroup = { alive: cleanup.groupAliveAfterCleanup, status: cleanup.ownershipStatus };
  }
  activeRun = null;
  return {
    exitCode: closed.exitCode ?? child.exitCode,
    signal: closed.signal ?? child.signalCode,
    error: spawnError?.message ?? null,
    timedOut: outcome.kind === "timeout",
    interrupted: outcome.kind === "interrupted" ? outcome.signal : null,
    cleanup,
    driverOwnership: {
      processGroupId: ownership.pid,
      initialStatus: ownership.initialStatus,
      postRunAlive: postRunGroup.alive,
      postRunStatus: postRunGroup.status,
      groupExtinctionConfirmed: postRunGroup.alive === false,
    },
  };
}

const runs = [];
let aggregateModelCalls = 0;
let aggregateModelTokens = 0;
for (let profileIndex = 0; profileIndex < PRODUCTION_FEATURE_PROFILES.length; profileIndex += 1) {
  const profile = PRODUCTION_FEATURE_PROFILES[profileIndex];
  if (interruptedSignal) break;
  console.log(`\n=== production feature profile ${profile} ===`);
  let preProfileProvenanceStatus = "PASS";
  let preProfileProvenanceError = null;
  try {
    assertRuntimeProvenanceUnchanged(repoRoot, runtimeProvenance);
  } catch (error) {
    preProfileProvenanceStatus = "FAIL";
    preProfileProvenanceError = error instanceof Error ? error.message : String(error);
  }
  if (preProfileProvenanceStatus !== "PASS") {
    runs.push({
      profile,
      exitCode: null,
      signal: null,
      error: "runtime provenance changed before profile launch",
      timedOut: false,
      interrupted: null,
      cleanup: null,
      receipt: null,
      receiptSha256: null,
      receiptBytes: null,
      receiptValidationStatus: "FAIL",
      receiptValidationError: "profile was not launched",
      preProfileProvenanceStatus,
      preProfileProvenanceError,
      harnessOverall: "NOT_RUN",
      featureStatus: "NOT_RUN",
      piTermination: null,
      modelCalls: null,
      budget: effectiveProfileBudgets[profile],
    });
    break;
  }
  const child = await runProfile(profile);
  let receipt = null;
  let observed = null;
  let receiptValidationStatus = "PASS";
  let receiptValidationError = null;
  try {
    const receiptSet = scanMatrixReceipts();
    const profilesAllowedSoFar = new Set(PRODUCTION_FEATURE_PROFILES.slice(0, profileIndex + 1));
    const premature = [...receiptSet.keys()].filter((candidate) => !profilesAllowedSoFar.has(candidate));
    if (premature.length > 0) {
      throw new Error(`extra receipts exist before their profiles ran: ${premature.join(", ")}`);
    }
    receipt = receiptSet.get(profile) ?? null;
    if (!receipt) throw new Error(`missing receipt for production feature profile: ${profile}`);
    observed = assertReceiptBoundToInitialProvenance(profile, receipt);
    aggregateModelCalls += observed.responses;
    aggregateModelTokens += observed.tokens;
  } catch (error) {
    receiptValidationStatus = "FAIL";
    receiptValidationError = error instanceof Error ? error.message : String(error);
  }
  const entry = {
    profile,
    ...child,
    receipt: receipt ? path.relative(repoRoot, receipt.path) : null,
    receiptSha256: receipt?.sha256 ?? null,
    receiptBytes: receipt?.bytes ?? null,
    receiptValidationStatus,
    receiptValidationError,
    preProfileProvenanceStatus,
    preProfileProvenanceError,
    harnessOverall: receipt?.parsed?.overall ?? "MISSING",
    featureStatus: receipt?.parsed?.featureEvidence?.status ?? "MISSING",
    piTermination: receipt?.parsed?.piTermination ?? null,
    modelCalls: observed?.responses ?? null,
    modelTokens: observed?.tokens ?? null,
    budget: effectiveProfileBudgets[profile],
  };
  runs.push(entry);
  if (child.exitCode !== 0
    || child.error !== null
    || child.driverOwnership?.initialStatus !== "VERIFIED"
    || child.driverOwnership?.groupExtinctionConfirmed !== true
    || entry.receiptValidationStatus !== "PASS"
    || entry.harnessOverall !== "PASS"
    || entry.featureStatus !== "PASS") break;
  if (aggregateModelCalls > aggregateModelCallCeiling
    || aggregateModelCalls > PRODUCTION_SUITE_MAX_MODEL_RESPONSES
    || aggregateModelTokens > aggregateModelTokenCeiling
    || aggregateModelTokens > PRODUCTION_SUITE_MAX_MODEL_TOKENS) break;
}

let receiptSetStatus = "PASS";
let receiptSetError = null;
let boundReceiptSet = [];
try {
  const finalReceiptSet = scanMatrixReceipts();
  const missing = EXPECTED_PROFILES.filter((profile) => !finalReceiptSet.has(profile));
  const extra = [...finalReceiptSet.keys()].filter((profile) => !EXPECTED_PROFILES.includes(profile));
  if (missing.length > 0 || extra.length > 0 || finalReceiptSet.size !== EXPECTED_PROFILES.length) {
    throw new Error(`receipt set mismatch; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}; count=${finalReceiptSet.size}`);
  }
  boundReceiptSet = EXPECTED_PROFILES.map((profile) => {
    const receipt = finalReceiptSet.get(profile);
    assertReceiptBoundToInitialProvenance(profile, receipt);
    return {
      profile,
      path: path.relative(repoRoot, receipt.path),
      sha256: receipt.sha256,
      bytes: receipt.bytes,
    };
  });
} catch (error) {
  receiptSetStatus = "FAIL";
  receiptSetError = error instanceof Error ? error.message : String(error);
}

let finalSourceRetention = null;
let sourceRetentionStatus = "PASS";
let sourceRetentionError = null;
try {
  finalSourceRetention = runManagedLogRetention(repoRoot);
  if (finalSourceRetention.blocked) throw new Error(finalSourceRetention.reasons.join("; "));
} catch (error) {
  sourceRetentionStatus = "FAIL";
  sourceRetentionError = error instanceof Error ? error.message : String(error);
}

const allProfilesPassed = runs.length === PRODUCTION_FEATURE_PROFILES.length
  && runs.every((run) => run.exitCode === 0
    && run.error === null
    && run.driverOwnership?.initialStatus === "VERIFIED"
    && run.driverOwnership?.groupExtinctionConfirmed === true
    && run.driverOwnership?.postRunAlive === false
    && run.preProfileProvenanceStatus === "PASS"
    && run.receiptValidationStatus === "PASS"
    && run.harnessOverall === "PASS"
    && run.featureStatus === "PASS"
    && (run.cleanup === null || run.cleanup.groupExtinctionConfirmed === true));
let runtimeProvenanceStatus = "PASS";
let runtimeProvenanceError = null;
let finalRuntimeProvenance = null;
try {
  finalRuntimeProvenance = assertRuntimeProvenanceUnchanged(repoRoot, runtimeProvenance);
} catch (error) {
  runtimeProvenanceStatus = "FAIL";
  runtimeProvenanceError = error instanceof Error ? error.message : String(error);
}
const finalRuntimeProvenanceDigest = finalRuntimeProvenance
  ? crypto.createHash("sha256").update(JSON.stringify(finalRuntimeProvenance)).digest("hex")
  : null;
const responseBudgetStatus = receiptSetStatus === "PASS"
  && aggregateModelCalls <= aggregateModelCallCeiling
  && aggregateModelCalls <= PRODUCTION_SUITE_MAX_MODEL_RESPONSES ? "PASS" : "FAIL";
const tokenBudgetStatus = receiptSetStatus === "PASS"
  && aggregateModelTokens <= aggregateModelTokenCeiling
  && aggregateModelTokens <= PRODUCTION_SUITE_MAX_MODEL_TOKENS ? "PASS" : "FAIL";
const executionStatus = allProfilesPassed
  && receiptSetStatus === "PASS"
  && responseBudgetStatus === "PASS"
  && tokenBudgetStatus === "PASS"
  && sourceRetentionStatus === "PASS"
  && runtimeProvenanceStatus === "PASS"
  && interruptedSignal === null ? "PASS" : "FAIL";
const certificationBlockers = [
  {
    id: "independent_judge",
    status: "BLOCKED_NOT_EXECUTED_IN_FEATURE_BOUNDARY",
    detail: "The feature boundary is kernel-derived and records zero judge verdicts; independent judge execution is a separate certification gate.",
  },
  {
    id: "signed_exact_head_attestation",
    status: "BLOCKED_SEPARATE_GATE_NOT_RUN",
    detail: "This matrix binds runtime provenance but does not execute or substitute for the signed trusted exact-HEAD verification gate.",
  },
  {
    id: "pricing_and_cost",
    status: "BLOCKED_PRICING_UNKNOWN",
    detail: "Authoritative route pricing and aggregate USD cost are unknown; missing cost is never represented as zero.",
  },
  {
    id: "c1_performance_comparison",
    status: "BLOCKED_SEPARATE_BENCHMARK_NOT_RUN",
    detail: "C1 overlap/behavior evidence is not a same-fixture baseline-versus-C1 performance comparison.",
  },
];
const result = {
  schema: "pi-iterative-goal.production-feature-matrix.v1",
  matrixId,
  startedAt,
  finishedAt: new Date().toISOString(),
  profiles: PRODUCTION_FEATURE_PROFILES,
  effectiveProfileBudgets,
  runtimeProvenance,
  runtimeProvenanceDigest,
  runtimeProvenanceStatus,
  runtimeProvenanceError,
  finalRuntimeProvenance,
  finalRuntimeProvenanceDigest,
  sourceRetention: {
    status: sourceRetentionStatus,
    error: sourceRetentionError,
    initial: initialSourceRetention,
    final: finalSourceRetention,
  },
  receiptSet: {
    status: receiptSetStatus,
    error: receiptSetError,
    expectedProfiles: EXPECTED_PROFILES,
    receipts: boundReceiptSet,
  },
  runs,
  interruptedSignal,
  aggregateModelResponses: {
    observed: aggregateModelCalls,
    ceiling: aggregateModelCallCeiling,
    hardSuiteCeiling: PRODUCTION_SUITE_MAX_MODEL_RESPONSES,
    status: responseBudgetStatus,
  },
  aggregateModelTokens: {
    observed: aggregateModelTokens,
    ceiling: aggregateModelTokenCeiling,
    hardSuiteCeiling: PRODUCTION_SUITE_MAX_MODEL_TOKENS,
    status: tokenBudgetStatus,
  },
  aggregateCostUsd: null,
  costGate: "BLOCKED_PRICING_UNKNOWN",
  executionStatus,
  certificationStatus: "NOT_CERTIFIED_SEPARATE_GATES_REQUIRED",
  certificationBlockers,
};
const tempPath = path.join(matrixDir, `results.${process.pid}.tmp`);
const resultsPath = path.join(matrixDir, "results.json");
const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
const resultSha256 = crypto.createHash("sha256").update(resultBytes).digest("hex");
fs.writeFileSync(tempPath, resultBytes, { mode: 0o600, flag: "wx" });
fs.renameSync(tempPath, resultsPath);
const digestPath = path.join(matrixDir, "results.sha256");
fs.writeFileSync(digestPath, `${resultSha256}  results.json\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(`\nfeature matrix execution: ${executionStatus}`);
console.log(`aggregate model responses: ${aggregateModelCalls}/${aggregateModelCallCeiling} (${responseBudgetStatus})`);
console.log(`aggregate model tokens: ${aggregateModelTokens}/${aggregateModelTokenCeiling} (${tokenBudgetStatus})`);
console.log("certification: NOT_CERTIFIED_SEPARATE_GATES_REQUIRED");
for (const blocker of certificationBlockers) console.log(`- ${blocker.id}: ${blocker.status}`);
console.log(`receipt: ${path.relative(repoRoot, resultsPath)}`);
console.log(`receipt sha256: ${resultSha256}`);

process.removeListener("SIGINT", onSigint);
process.removeListener("SIGTERM", onSigterm);
process.exit(executionStatus === "PASS" ? 0 : interruptedSignal ? 130 : 1);
