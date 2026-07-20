import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { TextDecoder } from "node:util";

const MANAGED_LOG_SCHEMA = "pi-iterative-goal.log.v1";
const MODEL_INVOCATION_SCHEMA = "pi-iterative-goal.model-invocation.v1";
const MATRIX_TELEMETRY_MAX_DIRECTORY_ENTRIES = 20_000;
const MATRIX_TELEMETRY_MAX_FILES = 256;
const MATRIX_TELEMETRY_MAX_FILE_BYTES = 16 * 1024 * 1024;
const MATRIX_TELEMETRY_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MATRIX_TELEMETRY_MAX_LINE_BYTES = 128 * 1024;
const MATRIX_TELEMETRY_MAX_RECORDS = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const PRODUCTION_FEATURE_PROFILES = Object.freeze([
  "off",
  "c1",
  "c1-c2",
  "c1-c2-c3",
  "c1-c2-c3-c4",
]);

export const PRODUCTION_FEATURE_PROFILE_BUDGETS = Object.freeze({
  off: Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  c1: Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  "c1-c2": Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  "c1-c2-c3": Object.freeze({ maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 }),
  "c1-c2-c3-c4": Object.freeze({ maxMinutes: 20, maxModelResponses: 60, maxTokens: 500_000 }),
});

const PROFILE_DEPTH = Object.freeze({
  off: 0,
  c1: 1,
  "c1-c2": 2,
  "c1-c2-c3": 3,
  "c1-c2-c3-c4": 4,
});

export const FEATURE_MATRIX_PLAN_ID = "matrix-plan-1";
export const FEATURE_MATRIX_REVIEW_TASK_IDS = Object.freeze([
  "matrix-c1-security",
  "matrix-c1-architecture",
]);
export const FEATURE_MATRIX_REVIEW_ROLES = Object.freeze({
  "matrix-c1-security": "Security reviewer",
  "matrix-c1-architecture": "Architecture/Ousterhout advisor",
});
export const FEATURE_MATRIX_CALIBRATION_TASK_IDS = Object.freeze([
  "matrix-c3-implementer-calibration-a",
  "matrix-c3-implementer-calibration-b",
]);
export const FEATURE_MATRIX_SCHEDULER_TASK_IDS = Object.freeze([
  "sched-c1-shard-1",
  "sched-c1-shard-2",
]);
export const FEATURE_MATRIX_WORKER_PROFILE = "zai_glm_5_2";
export const FEATURE_MATRIX_WORKER_PROVIDER = "zai";
export const FEATURE_MATRIX_WORKER_MODEL = "glm-5.2";

const FEATURE_FILE_CONTENTS = Object.freeze({
  "feature-a.txt": "alpha\n",
  "feature-b.txt": "beta\n",
});

export function requireFeatureProfile(profile) {
  if (!Object.hasOwn(PROFILE_DEPTH, profile)) {
    throw new Error(`unknown feature profile '${profile}'; expected ${PRODUCTION_FEATURE_PROFILES.join(", ")}`);
  }
  return profile;
}

export function featureProfileDepth(profile) {
  return PROFILE_DEPTH[requireFeatureProfile(profile)];
}

export function featureProfileBudget(profile) {
  return PRODUCTION_FEATURE_PROFILE_BUDGETS[requireFeatureProfile(profile)];
}

/**
 * Keep the live feature-boundary prompt surface derived from the same cumulative
 * depth contract as the kernel settings. In particular, OFF must not invite
 * feature stimulus and C1 must not ask for the C2 shard-plan tool.
 */
export function buildFeatureBoundaryPromptContract(profile) {
  const depth = featureProfileDepth(profile);
  return Object.freeze({
    toolAllowlist: Object.freeze([
      "goal_repo_context",
      "goal_report_phase_result",
      "goal_update_task_plan",
      ...(depth >= 1 ? ["goal_subagent"] : []),
      ...(depth >= 2 ? ["goal_post_shards"] : []),
    ]),
    planActionIds: Object.freeze([
      ...(depth >= 1 ? ["parallel_review"] : []),
      ...(depth >= 3 ? ["parallel_calibration"] : []),
      "update_task_plan",
      ...(depth >= 2 ? ["post_shards"] : []),
      "report_phase_result",
    ]),
    criterion: depth === 0
      ? "The runtime reaches the implement boundary with README.md unchanged at the seed commit and zero C1-C4 task, worker invocation, shard plan, claim, patch artifact, merge, feature event, or tracked-file effect."
      : depth >= 4
        ? "feature-a.txt contains exactly the line 'alpha', feature-b.txt contains exactly the line 'beta', and both grep -qx checks exit 0."
        : "hello.txt exists containing exactly the line 'ok' and the command grep -qx ok hello.txt exits 0.",
  });
}

/**
 * C1-C4 form a strict dependency chain. These are the only valid production
 * combinations: each profile enables one more campaign while retaining all
 * prerequisites, and every later feature remains explicitly disabled.
 */
export function buildFeatureProfileSettings(profile) {
  const depth = featureProfileDepth(profile);
  return {
    swarm: {
      enabled: depth >= 1,
      defaultConcurrency: 2,
    },
    sharder: {
      enabled: depth >= 2,
      maxShards: 2,
    },
    scheduler: {
      enabled: depth >= 3,
      concurrency: 2,
      workerModelProfile: FEATURE_MATRIX_WORKER_PROFILE,
    },
    mergeBack: {
      enabled: depth >= 4,
      promoteToSource: depth >= 4,
      testCommand: "git diff --check",
      testTimeoutMs: 30_000,
    },
  };
}

export function intervalsOverlap(left, right) {
  const leftStart = Date.parse(left?.startedAt ?? "");
  const leftEnd = Date.parse(left?.finishedAt ?? left?.endedAt ?? "");
  const rightStart = Date.parse(right?.startedAt ?? "");
  const rightEnd = Date.parse(right?.finishedAt ?? right?.endedAt ?? "");
  return [leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)
    && Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd);
}

function assertMatrixTelemetryRegularFile(filePath, maximumBytes) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is unavailable; matrix telemetry cannot be trusted");
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error(`matrix telemetry is not a non-empty bounded regular file: ${filePath}`);
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
      throw new Error(`matrix telemetry changed during bounded read: ${filePath}`);
    }
    return {
      bytes,
      identity: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mode: before.mode,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertMatrixTelemetryIdentityUnchanged(filePath, expected) {
  const current = fs.lstatSync(filePath);
  if (current.isSymbolicLink() || !current.isFile()
    || current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size
    || current.mode !== expected.mode || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) {
    throw new Error(`matrix telemetry changed after bounded read: ${filePath}`);
  }
}

function strictIsoTimestamp(value, field, source) {
  if (typeof value !== "string") throw new Error(`${source}: ${field} must be an ISO timestamp`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new Error(`${source}: ${field} must be a canonical ISO timestamp`);
  }
  return epoch;
}

function assertNullableString(value, field, source) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${source}: ${field} must be a string or null`);
  }
}

function assertNonNegativeFinite(value, field, source, integer = false) {
  const valid = typeof value === "number" && Number.isFinite(value) && value >= 0
    && (!integer || Number.isSafeInteger(value));
  if (!valid) throw new Error(`${source}: ${field} must be a non-negative ${integer ? "safe integer" : "finite number"}`);
}

function assertNullableNonNegativeFinite(value, field, source, integer = false) {
  if (value !== null) assertNonNegativeFinite(value, field, source, integer);
}

function assertStrictModelInvocation(value, runId, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: model invocation metadata must be an object`);
  }
  if (value.schema !== MODEL_INVOCATION_SCHEMA) {
    throw new Error(`${source}: wrong model invocation schema`);
  }
  for (const field of [
    "invocationId", "role", "workloadClass", "routeId", "provider",
    "requestedModel", "familyId", "servingVariant",
  ]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`${source}: ${field} must be a non-empty string`);
    }
  }
  if (value.runId !== runId) throw new Error(`${source}: model invocation runId mismatch`);
  for (const field of [
    "sessionId", "phase", "phaseAttemptId", "taskId", "fixtureHash", "responseModel",
    "reasoningEffort", "serviceTier", "fallbackReason", "errorCode", "requestDigest", "resultDigest",
  ]) assertNullableString(value[field], field, source);
  if (value.cycle !== null) assertNonNegativeFinite(value.cycle, "cycle", source, true);
  assertNonNegativeFinite(value.attempt, "attempt", source, true);
  if (value.attempt < 1) throw new Error(`${source}: attempt must be at least one`);
  const startedAt = strictIsoTimestamp(value.startedAt, "startedAt", source);
  const endedAt = strictIsoTimestamp(value.endedAt, "endedAt", source);
  if (endedAt < startedAt) throw new Error(`${source}: endedAt precedes startedAt`);
  if (value.firstTokenAt !== null) {
    const firstTokenAt = strictIsoTimestamp(value.firstTokenAt, "firstTokenAt", source);
    if (firstTokenAt < startedAt || firstTokenAt > endedAt) {
      throw new Error(`${source}: firstTokenAt is outside the invocation interval`);
    }
  }
  assertNonNegativeFinite(value.latencyMs, "latencyMs", source);
  for (const field of ["ttftMs", "outputTokensPerSecond", "costUsd"]) {
    assertNullableNonNegativeFinite(value[field], field, source);
  }
  for (const field of [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "turns", "toolCallCount", "toolErrorCount",
  ]) assertNonNegativeFinite(value[field], field, source, true);
  assertNullableNonNegativeFinite(value.reasoningTokens, "reasoningTokens", source, true);
  if (!["success", "provider_error", "timeout", "cancelled", "schema_error", "gate_failure", "budget_exhausted"].includes(value.termination)) {
    throw new Error(`${source}: invalid termination`);
  }
  if (!["PASS", "FAIL", "NOT_RUN"].includes(value.gateStatus)) {
    throw new Error(`${source}: invalid gateStatus`);
  }
  return value;
}

/**
 * Matrix-only telemetry loader. Unlike the general comparison loader, this
 * treats every selected byte as certification evidence: malformed JSON,
 * unterminated lines, wrong schemas, chain gaps, hash corruption, or a stale
 * chain-head sidecar abort the matrix instead of silently dropping records.
 */
export function loadStrictFeatureMatrixInvocations(cwd, runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(runId)) {
    throw new Error("matrix telemetry requires an exact safe runId");
  }
  const directory = path.join(path.resolve(cwd), ".pi", "iterative-goal", "managed", "telemetry", "invocations");
  if (!fs.existsSync(directory)) return [];
  const directoryStat = fs.lstatSync(directory);
  const canonicalDirectory = fs.realpathSync(directory);
  const expectedCanonicalDirectory = path.join(
    fs.realpathSync(path.resolve(cwd)),
    ".pi", "iterative-goal", "managed", "telemetry", "invocations",
  );
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
    || canonicalDirectory !== expectedCanonicalDirectory) {
    throw new Error(`matrix telemetry directory is not trusted: ${directory}`);
  }
  const activeName = `${runId}.jsonl`;
  const headName = `${activeName}.head.json`;
  const lockName = `${activeName}.lock`;
  const rotationPattern = new RegExp(`^${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.jsonl\\.([1-9][0-9]*)\\.gz$`);
  const selected = [];
  let headPresent = false;
  let directoryEntries = 0;
  const directoryHandle = fs.opendirSync(directory);
  try {
    let entry;
    while ((entry = directoryHandle.readSync()) !== null) {
      directoryEntries += 1;
      if (directoryEntries > MATRIX_TELEMETRY_MAX_DIRECTORY_ENTRIES) {
        throw new Error(`matrix telemetry directory exceeds the ${MATRIX_TELEMETRY_MAX_DIRECTORY_ENTRIES}-entry scan bound`);
      }
      if (entry.name === lockName) throw new Error(`matrix telemetry remains locked or incomplete: ${lockName}`);
      if (entry.name === headName) {
        headPresent = true;
        continue;
      }
      if (entry.name === activeName) {
        selected.push({ name: entry.name, generation: 0, compressed: false });
        continue;
      }
      const rotation = entry.name.match(rotationPattern);
      if (rotation) {
        selected.push({ name: entry.name, generation: Number(rotation[1]), compressed: true });
        continue;
      }
      if (entry.name.startsWith(`${activeName}.`)) {
        throw new Error(`matrix telemetry has an unexpected run-scoped companion: ${entry.name}`);
      }
    }
  } finally {
    directoryHandle.closeSync();
  }
  if (selected.length === 0) {
    if (headPresent) throw new Error("matrix telemetry has a chain head without records");
    return [];
  }
  if (selected.length > MATRIX_TELEMETRY_MAX_FILES) {
    throw new Error(`matrix telemetry exceeds the ${MATRIX_TELEMETRY_MAX_FILES}-file bound`);
  }
  if (!selected.some((item) => item.generation === 0) || !headPresent) {
    throw new Error("matrix telemetry is missing its active log or chain head");
  }
  const generations = selected.map((item) => item.generation).sort((left, right) => left - right);
  if (new Set(generations).size !== generations.length
    || generations.some((generation, index) => generation !== index)) {
    throw new Error("matrix telemetry rotation sequence is duplicate or incomplete");
  }
  selected.sort((left, right) => right.generation - left.generation);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = [];
  const snapshots = [];
  let decompressedBytes = 0;
  let expectedSequence = 1;
  let previousHash = null;
  let lastTimestamp = null;
  for (const item of selected) {
    const filePath = path.join(directory, item.name);
    const read = assertMatrixTelemetryRegularFile(filePath, MATRIX_TELEMETRY_MAX_FILE_BYTES);
    snapshots.push({ filePath, identity: read.identity });
    let contentBytes;
    if (item.compressed) {
      try {
        contentBytes = zlib.gunzipSync(read.bytes, {
          maxOutputLength: MATRIX_TELEMETRY_MAX_DECOMPRESSED_BYTES - decompressedBytes,
        });
      } catch (error) {
        throw new Error(`matrix telemetry gzip is invalid or too large: ${filePath}`, { cause: error });
      }
    } else {
      contentBytes = read.bytes;
    }
    decompressedBytes += contentBytes.length;
    if (decompressedBytes > MATRIX_TELEMETRY_MAX_DECOMPRESSED_BYTES) {
      throw new Error(`matrix telemetry exceeds the ${MATRIX_TELEMETRY_MAX_DECOMPRESSED_BYTES}-byte decompression bound`);
    }
    if (contentBytes.at(-1) !== 10) {
      throw new Error(`matrix telemetry contains an unterminated record: ${filePath}`);
    }
    let content;
    try {
      content = decoder.decode(contentBytes);
    } catch (error) {
      throw new Error(`matrix telemetry is not valid UTF-8: ${filePath}`, { cause: error });
    }
    const lines = content.slice(0, -1).split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const source = `${filePath}:${lineIndex + 1}`;
      if (line.length === 0 || line.includes("\r")) {
        throw new Error(`${source}: matrix telemetry contains a blank or CR-delimited record`);
      }
      if (Buffer.byteLength(line) > MATRIX_TELEMETRY_MAX_LINE_BYTES) {
        throw new Error(`${source}: matrix telemetry line exceeds the ${MATRIX_TELEMETRY_MAX_LINE_BYTES}-byte bound`);
      }
      if (records.length >= MATRIX_TELEMETRY_MAX_RECORDS) {
        throw new Error(`matrix telemetry exceeds the ${MATRIX_TELEMETRY_MAX_RECORDS}-record bound`);
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`${source}: malformed matrix telemetry JSON`, { cause: error });
      }
      if (!event || typeof event !== "object" || Array.isArray(event) || event.schema !== MANAGED_LOG_SCHEMA) {
        throw new Error(`${source}: wrong managed-log schema`);
      }
      if (event.stream !== "model-invocations" || event.scope !== "model-telemetry"
        || event.message !== "model invocation completed" || event.runId !== runId) {
        throw new Error(`${source}: matrix telemetry envelope identity mismatch`);
      }
      if (event.sequence !== expectedSequence || event.previousHash !== previousHash) {
        throw new Error(`${source}: matrix telemetry sequence chain is corrupt`);
      }
      if (typeof event.hash !== "string" || !SHA256_PATTERN.test(event.hash)) {
        throw new Error(`${source}: matrix telemetry hash is malformed`);
      }
      const { hash, ...base } = event;
      const expectedHash = crypto.createHash("sha256")
        .update(`${previousHash ?? "GENESIS"}\n${JSON.stringify(base)}`)
        .digest("hex");
      if (hash !== expectedHash) throw new Error(`${source}: matrix telemetry hash chain is corrupt`);
      strictIsoTimestamp(event.timestamp, "timestamp", source);
      if (!Number.isSafeInteger(event.pid) || event.pid <= 0
        || !["debug", "info", "warn", "error"].includes(event.level)) {
        throw new Error(`${source}: matrix telemetry envelope shape is invalid`);
      }
      assertNullableString(event.phaseAttemptId, "phaseAttemptId", source);
      const invocation = assertStrictModelInvocation(event.metadata, runId, source);
      if (event.phaseAttemptId !== invocation.phaseAttemptId) {
        throw new Error(`${source}: envelope phaseAttemptId does not bind its invocation`);
      }
      records.push(invocation);
      expectedSequence += 1;
      previousHash = hash;
      lastTimestamp = event.timestamp;
    }
  }

  const headPath = path.join(directory, headName);
  const headRead = assertMatrixTelemetryRegularFile(headPath, 64 * 1024);
  let head;
  try {
    head = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headRead.bytes));
  } catch (error) {
    throw new Error(`matrix telemetry chain head is malformed: ${headPath}`, { cause: error });
  }
  if (!head || typeof head !== "object" || Array.isArray(head)
    || head.sequence !== expectedSequence - 1 || head.hash !== previousHash || head.updatedAt !== lastTimestamp) {
    throw new Error(`matrix telemetry chain head does not match the verified tail: ${headPath}`);
  }
  for (const snapshot of snapshots) {
    assertMatrixTelemetryIdentityUnchanged(snapshot.filePath, snapshot.identity);
  }
  assertMatrixTelemetryIdentityUnchanged(headPath, headRead.identity);
  const directoryAfter = fs.lstatSync(directory);
  if (directoryAfter.isSymbolicLink() || !directoryAfter.isDirectory()
    || directoryAfter.dev !== directoryStat.dev || directoryAfter.ino !== directoryStat.ino
    || directoryAfter.mtimeMs !== directoryStat.mtimeMs || directoryAfter.ctimeMs !== directoryStat.ctimeMs
    || fs.realpathSync(directory) !== canonicalDirectory) {
    throw new Error(`matrix telemetry directory changed during strict load: ${directory}`);
  }
  return records;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function eventTypeCounts(events) {
  const counts = {};
  for (const event of events) {
    const type = typeof event?.type === "string" ? event.type : typeof event?.kind === "string" ? event.kind : "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function normalizeEvidencePath(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/") : null;
}

function expectedWorkerTaskIds(depth) {
  return [
    ...(depth >= 1 ? FEATURE_MATRIX_REVIEW_TASK_IDS : []),
    ...(depth >= 3 ? FEATURE_MATRIX_CALIBRATION_TASK_IDS : []),
    ...(depth >= 3 ? FEATURE_MATRIX_SCHEDULER_TASK_IDS : []),
  ];
}

function expectedWorkerRole(taskId) {
  return FEATURE_MATRIX_REVIEW_ROLES[taskId]
    ?? (FEATURE_MATRIX_CALIBRATION_TASK_IDS.includes(taskId) || FEATURE_MATRIX_SCHEDULER_TASK_IDS.includes(taskId)
      ? "Implementer"
      : null);
}

/**
 * The production fixture requires one ordinary unified diff that creates one
 * exact file with one exact line. This parser intentionally accepts much less
 * than general Git patch syntax: exotic or multi-file patches fail closed.
 */
function patchCreatesExactFeatureFile(patchText, targetPath, expectedContent) {
  if (typeof patchText !== "string" || patchText.length === 0 || patchText.includes("\r")) return false;
  const sections = patchText.split(/^diff --git /m).filter((part) => part.length > 0);
  if (sections.length !== 1) return false;
  const lines = sections[0].split("\n");
  if (lines.shift() !== `a/${targetPath} b/${targetPath}`) return false;
  if (!lines.includes("new file mode 100644")) return false;
  const oldIndex = lines.indexOf("--- /dev/null");
  const newIndex = lines.indexOf(`+++ b/${targetPath}`);
  if (oldIndex < 0 || newIndex !== oldIndex + 1) return false;

  const additions = [];
  let inHunk = false;
  let hunkCount = 0;
  for (const line of lines.slice(newIndex + 1)) {
    if (line.startsWith("@@ ")) {
      hunkCount += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || line === "") continue;
    if (line.startsWith("+")) additions.push(line.slice(1));
    else if (line.startsWith("-") || line.startsWith(" ") || line === "\\ No newline at end of file") return false;
  }
  return hunkCount === 1 && `${additions.join("\n")}\n` === expectedContent;
}

/**
 * Derive a compact production proof from kernel-owned state/events and Git
 * observations. No model-authored summary can make a check pass.
 */
export function evaluateFeatureProfileEvidence(profile, input) {
  const depth = featureProfileDepth(profile);
  const events = Array.isArray(input?.events) ? input.events : [];
  const state = input?.state && typeof input.state === "object" ? input.state : {};
  const tasks = Array.isArray(state?.swarm?.tasks) ? state.swarm.tasks : [];
  const plans = Array.isArray(state?.shards?.plans) ? state.shards.plans : [];
  const claims = Array.isArray(state?.shards?.claims) ? state.shards.claims : [];
  const merges = Array.isArray(state?.shards?.merges) ? state.shards.merges : [];
  const artifacts = Array.isArray(input?.patchArtifacts) ? input.patchArtifacts : [];
  const patchContents = input?.patchContents && typeof input.patchContents === "object" ? input.patchContents : {};
  const workerInvocations = Array.isArray(input?.workerInvocations) ? input.workerInvocations : [];
  const coordinatorInvocations = Array.isArray(input?.coordinatorInvocations) ? input.coordinatorInvocations : [];
  const mainTurns = input?.mainTurns;
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed: passed === true, detail });

  const runtimeCommands = Array.isArray(input?.runtimeCommands) ? input.runtimeCommands : [];
  const requiredRuntimeCommands = ["goal-start", "goal-status", "goal-authorize-release"];
  add("runtime_extension_commands", requiredRuntimeCommands.every((command) => runtimeCommands.includes(command)),
    `required=${requiredRuntimeCommands.join(",")}; observed=${runtimeCommands.slice().sort().join(",") || "none"}`);
  add("runtime_state_active_at_boundary", state?.status === "running",
    `status=${state?.status ?? "missing"}; phase=${state?.phase ?? "missing"}`);
  add("tracked_worktree_clean_at_boundary", input?.trackedWorktreeStatus === "",
    `status=${input?.trackedWorktreeStatus || "clean"}`);
  add("coordinator_exact_invocation_count", Number.isSafeInteger(mainTurns)
    && mainTurns > 0
    && coordinatorInvocations.length === mainTurns,
  `mainTurns=${String(mainTurns)}; invocations=${coordinatorInvocations.length}`);
  add("coordinator_exact_zai_identity", coordinatorInvocations.length > 0
    && coordinatorInvocations.every((invocation) => invocation?.taskId === null
      && invocation?.role === "Coordinator"
      && invocation?.routeId === FEATURE_MATRIX_WORKER_PROFILE
      && invocation?.provider === FEATURE_MATRIX_WORKER_PROVIDER
      && invocation?.requestedModel === FEATURE_MATRIX_WORKER_MODEL
      && invocation?.responseModel === FEATURE_MATRIX_WORKER_MODEL
      && invocation?.termination === "success"
      && invocation?.errorCode === null),
  coordinatorInvocations.map((invocation) => `${invocation?.routeId ?? "missing"}:${invocation?.provider ?? "missing"}/${invocation?.requestedModel ?? "missing"}->${invocation?.responseModel ?? "missing"}:${invocation?.termination ?? "missing"}:${invocation?.errorCode ?? "ok"}`).join(", ") || "missing coordinator invocations");

  const settings = buildFeatureProfileSettings(profile);
  add("profile_flags_exact", [
    settings.swarm.enabled,
    settings.sharder.enabled,
    settings.scheduler.enabled,
    settings.mergeBack.enabled,
  ].every((enabled, index) => enabled === (depth >= index + 1)), JSON.stringify(settings));
  const expectedTaskIds = expectedWorkerTaskIds(depth);
  const stateTaskIds = tasks.map((task) => task?.taskId).filter((taskId) => typeof taskId === "string");
  const observedTaskIds = workerInvocations.map((invocation) => invocation?.taskId).filter((taskId) => typeof taskId === "string");
  add("state_exact_terminal_task_set", tasks.length === expectedTaskIds.length
    && new Set(stateTaskIds).size === expectedTaskIds.length
    && expectedTaskIds.every((taskId) => stateTaskIds.includes(taskId))
    && tasks.every((task) => task?.status === "completed" && typeof task?.finishedAt === "string"),
  `expected=${expectedTaskIds.join(",")}; observed=${tasks.map((task) => `${task?.taskId ?? "missing"}:${task?.status ?? "missing"}`).join(",") || "none"}`);
  add("state_exact_role_binding", tasks.length === expectedTaskIds.length
    && tasks.every((task) => task?.role === expectedWorkerRole(task?.taskId)),
  tasks.map((task) => `${task?.taskId ?? "missing"}:${task?.role ?? "missing"}`).join(",") || "none");
  add("workers_exact_task_set", workerInvocations.length === expectedTaskIds.length
    && new Set(observedTaskIds).size === expectedTaskIds.length
    && expectedTaskIds.every((taskId) => observedTaskIds.includes(taskId)),
  `expected=${expectedTaskIds.join(",")}; observed=${observedTaskIds.join(",") || "none"}`);
  add("workers_exact_zai_identity", workerInvocations.length === expectedTaskIds.length
    && workerInvocations.every((invocation) => expectedTaskIds.includes(invocation?.taskId)
      && invocation?.routeId === FEATURE_MATRIX_WORKER_PROFILE
      && invocation?.provider === FEATURE_MATRIX_WORKER_PROVIDER
      && invocation?.requestedModel === FEATURE_MATRIX_WORKER_MODEL
      && invocation?.responseModel === FEATURE_MATRIX_WORKER_MODEL
      && invocation?.termination === "success"
      && invocation?.errorCode === null),
  workerInvocations.map((invocation) => `${invocation?.taskId ?? "missing"}:${invocation?.routeId ?? "missing"}:${invocation?.provider ?? "missing"}/${invocation?.requestedModel ?? "missing"}->${invocation?.responseModel ?? "missing"}:${invocation?.termination ?? "missing"}:${invocation?.errorCode ?? "ok"}`).join(", ") || "missing workers");
  add("workers_exact_role_binding", workerInvocations.length === expectedTaskIds.length
    && workerInvocations.every((invocation) => invocation?.role === expectedWorkerRole(invocation?.taskId)),
  workerInvocations.map((invocation) => `${invocation?.taskId ?? "missing"}:${invocation?.role ?? "missing"}`).join(",") || "none");

  if (depth >= 1) {
    const reviewTasks = FEATURE_MATRIX_REVIEW_TASK_IDS.map((id) => tasks.find((task) => task.taskId === id));
    const reviewInvocations = FEATURE_MATRIX_REVIEW_TASK_IDS
      .map((id) => workerInvocations.find((invocation) => invocation?.taskId === id));
    const reviewLedgerOverlap = intervalsOverlap(reviewTasks[0], reviewTasks[1]);
    const reviewTelemetryOverlap = reviewInvocations.every(Boolean)
      && intervalsOverlap(reviewInvocations[0], reviewInvocations[1]);
    add("c1_parallel_batch_completed", reviewTasks.every((task) => task?.status === "completed" && task.mode === "parallel"),
      reviewTasks.map((task) => task ? `${task.taskId}:${task.status}:${task.mode}` : "missing").join(", "));
    add("c1_parallel_batch_exact_route", reviewTasks.every((task) => task?.routeId === FEATURE_MATRIX_WORKER_PROFILE
      && task.provider === "zai" && task.requestedModel === "glm-5.2"),
    reviewTasks.map((task) => task ? `${task.taskId}:${task.routeId}:${task.provider}/${task.requestedModel}` : "missing").join(", "));
    add("c1_parallel_intervals_overlap", reviewLedgerOverlap && reviewTelemetryOverlap,
      `ledger=${reviewTasks.map((task) => task ? `${task.taskId}:${task.startedAt}..${task.finishedAt}` : "missing").join(", ")}; telemetry=${reviewInvocations.map((invocation) => invocation ? `${invocation.taskId}:${invocation.startedAt}..${invocation.endedAt}` : "missing").join(", ")}`);
  } else {
    const subagentToolCalls = Array.isArray(input?.subagentToolCalls) ? input.subagentToolCalls : [];
    add("c1_remains_disabled", tasks.length === 0 && workerInvocations.length === 0 && subagentToolCalls.length === 0,
      `tasks=${tasks.length}; invocations=${workerInvocations.length}; calls=${subagentToolCalls.length}`);
    add("off_no_feature_tasks", tasks.length === 0, `tasks=${tasks.length}`);
    add("off_no_worker_telemetry", workerInvocations.length === 0, `invocations=${workerInvocations.length}`);
  }

  const plan = [...plans].reverse().find((candidate) => candidate?.id === FEATURE_MATRIX_PLAN_ID);
  if (depth >= 2) {
    const proposed = events.some((event) => event?.type === "shard_plan_proposed" && event?.entry?.plan?.id === FEATURE_MATRIX_PLAN_ID);
    add("c2_plan_proposed", proposed, `plan=${FEATURE_MATRIX_PLAN_ID}`);
    const planTaskIds = Array.isArray(plan?.tasks) ? plan.tasks.map((task) => task?.id) : [];
    const planShardIds = Array.isArray(plan?.shards) ? plan.shards.map((shard) => shard?.id) : [];
    const shardFiles = Array.isArray(plan?.shards) ? plan.shards.flatMap((shard) => Array.isArray(shard?.files) ? shard.files : []) : [];
    add("c2_fan_out_posted", plans.length === 1
      && plan?.decision === "fan_out"
      && plan?.shards?.length === 2
      && new Set(planTaskIds).size === 2
      && ["feature-a", "feature-b"].every((taskId) => planTaskIds.includes(taskId))
      && new Set(planShardIds).size === 2
      && new Set(shardFiles).size === 2
      && ["feature-a.txt", "feature-b.txt"].every((file) => shardFiles.includes(file))
      && plan.shards.every((shard) => shard.files?.length === 1
        && shard.taskIds?.length === 1
        && shard.allowedPaths?.length === 1
        && shard.allowedPaths[0]?.kind === "exact"
        && shard.allowedPaths[0]?.path === shard.files[0]),
      plan ? `${plan.decision}; shards=${plan.shards?.length ?? 0}; reason=${plan.decisionReason ?? ""}` : "missing plan");
    add("c2_spectral_kl_evidence", plan?.algorithm?.prior === "spectral-fiedler"
      && ["sign", "median"].includes(plan?.algorithm?.priorSplit)
      && plan?.algorithm?.refinement === "kernighan-lin"
      && Number.isSafeInteger(plan?.algorithm?.bisections) && plan.algorithm.bisections >= 1
      && Number.isSafeInteger(plan?.algorithm?.refinementPasses) && plan.algorithm.refinementPasses >= 1
      && Number.isSafeInteger(plan?.algorithm?.refinementEvaluatedSwaps) && plan.algorithm.refinementEvaluatedSwaps >= 0
      && Number.isFinite(plan?.algorithm?.initialCutWeight)
      && Number.isFinite(plan?.cutWeight)
      && Number.isFinite(plan?.couplingDensity),
    JSON.stringify(plan?.algorithm ?? null));
  } else {
    add("c2_remains_disabled", plans.length === 0, `plans=${plans.length}`);
  }

  const planClaims = claims.filter((claim) => claim?.planId === FEATURE_MATRIX_PLAN_ID);
  const schedulerTasks = tasks.filter((task) => typeof task?.taskId === "string" && task.taskId.startsWith("sched-c1-shard-"));
  const schedulerInvocations = FEATURE_MATRIX_SCHEDULER_TASK_IDS
    .map((id) => workerInvocations.find((invocation) => invocation?.taskId === id));
  if (depth >= 3) {
    const calibrationTasks = FEATURE_MATRIX_CALIBRATION_TASK_IDS.map((id) => tasks.find((task) => task.taskId === id));
    add("c3_real_implementer_calibration", calibrationTasks.every((task) => task?.status === "completed"
      && task?.role === "Implementer" && task?.usage && task.usage.turns >= 1),
    calibrationTasks.map((task) => task ? `${task.taskId}:${task.status}:turns=${task.usage?.turns ?? "missing"}` : "missing").join(", "));
    const expectedShardIds = Array.isArray(plan?.shards)
      ? plan.shards.map((shard) => shard?.id).filter((id) => typeof id === "string")
      : [];
    const claimShardIds = planClaims.map((claim) => claim?.shardId);
    const artifactShardIds = artifacts.map((artifact) => artifact?.shardId);
    const schedulerTaskIds = schedulerTasks.map((task) => task?.taskId);
    add("c3_claims_complete", claims.length === 2
      && expectedShardIds.length === 2
      && new Set(expectedShardIds).size === 2
      && planClaims.length === 2
      && new Set(claimShardIds).size === 2
      && expectedShardIds.every((shardId) => claimShardIds.includes(shardId))
      && planClaims.every((claim) => claim.status === "completed"),
    planClaims.map((claim) => `${claim.shardId}:${claim.status}`).join(", ") || "missing claims");
    const claimEvents = events.filter((event) => event?.type === "shard_claimed"
      && event?.planId === FEATURE_MATRIX_PLAN_ID);
    add("c3_heft_awards_telemetry_calibrated", claimEvents.length === 2
      && new Set(claimEvents.map((event) => event?.shardId)).size === 2
      && expectedShardIds.length === 2
      && expectedShardIds.every((shardId) => claimEvents.some((event) => event?.shardId === shardId))
      && claimEvents.every((event) => event?.evidence?.strategy === "heft"
        && Number.isFinite(event?.evidence?.rank)
        && Number.isSafeInteger(event?.evidence?.slot)
        && event.evidence.shortlistSize >= 1),
    claimEvents.map((event) => `${event?.shardId ?? "missing"}:${event?.evidence?.strategy ?? "missing"}:rank=${event?.evidence?.rank ?? "missing"}:slot=${event?.evidence?.slot ?? "missing"}`).join(", ") || "missing awards");
    add("c3_workers_exact_route", schedulerTasks.length === FEATURE_MATRIX_SCHEDULER_TASK_IDS.length
      && new Set(schedulerTaskIds).size === FEATURE_MATRIX_SCHEDULER_TASK_IDS.length
      && FEATURE_MATRIX_SCHEDULER_TASK_IDS.every((taskId) => schedulerTaskIds.includes(taskId))
      && schedulerTasks.every((task) => task.status === "completed"
        && task.routeId === FEATURE_MATRIX_WORKER_PROFILE && task.provider === "zai" && task.requestedModel === "glm-5.2"),
    schedulerTasks.map((task) => `${task.taskId}:${task.status}:${task.routeId}:${task.provider}/${task.requestedModel}`).join(", ") || "missing workers");
    add("c3_worker_intervals_overlap", schedulerTasks.length === 2
      && intervalsOverlap(schedulerTasks[0], schedulerTasks[1])
      && schedulerInvocations.every(Boolean)
      && intervalsOverlap(schedulerInvocations[0], schedulerInvocations[1]),
    `ledger=${schedulerTasks.map((task) => `${task.taskId}:${task.startedAt}..${task.finishedAt}`).join(", ") || "missing workers"}; telemetry=${schedulerInvocations.map((invocation) => invocation ? `${invocation.taskId}:${invocation.startedAt}..${invocation.endedAt}` : "missing").join(", ")}`);
    add("c3_complete_patch_artifacts", artifacts.length === 2
      && new Set(artifactShardIds).size === 2
      && expectedShardIds.every((shardId) => artifactShardIds.includes(shardId))
      && artifacts.every((artifact) => artifact.bytes > 0
        && typeof artifact.sha256 === "string" && artifact.sha256.length === 64),
    artifacts.map((artifact) => `${artifact.shardId}:${artifact.bytes}:${artifact.sha256}`).join(", ") || "missing artifacts");
    const claimsByShard = new Map(planClaims.map((claim) => [claim.shardId, claim]));
    add("c3_patch_artifacts_bound", artifacts.length === 2 && artifacts.every((artifact) => {
      const claim = claimsByShard.get(artifact?.shardId);
      return claim && normalizeEvidencePath(claim.patchArtifactPath) === normalizeEvidencePath(artifact.path);
    }), artifacts.map((artifact) => `${artifact?.shardId ?? "missing"}:${normalizeEvidencePath(artifact?.path) ?? "missing"}`).join(", ") || "missing artifacts");
    add("c3_patch_hashes_match_content", artifacts.length === 2 && artifacts.every((artifact) => {
      const content = patchContents[artifact.path];
      return typeof content === "string"
        && Buffer.byteLength(content) === artifact.bytes
        && digest(content) === artifact.sha256;
    }), artifacts.map((artifact) => `${artifact?.shardId ?? "missing"}:${artifact?.sha256 ?? "missing"}`).join(", ") || "missing artifacts");
    add("c3_patch_contents_exact", artifacts.length === 2 && artifacts.every((artifact) => {
      const shard = plan?.shards?.find((candidate) => candidate?.id === artifact?.shardId);
      const targetPath = Array.isArray(shard?.files) && shard.files.length === 1 ? shard.files[0] : null;
      const expectedContent = targetPath ? FEATURE_FILE_CONTENTS[targetPath] : null;
      return typeof targetPath === "string" && typeof expectedContent === "string"
        && patchCreatesExactFeatureFile(patchContents[artifact.path], targetPath, expectedContent);
    }), artifacts.map((artifact) => {
      const shard = plan?.shards?.find((candidate) => candidate?.id === artifact?.shardId);
      return `${artifact?.shardId ?? "missing"}:${Array.isArray(shard?.files) ? shard.files.join("+") : "missing"}`;
    }).join(", ") || "missing artifacts");
  } else {
    add("c3_remains_disabled", claims.length === 0 && schedulerTasks.length === 0 && artifacts.length === 0,
      `claims=${claims.length}; schedulerTasks=${schedulerTasks.length}; artifacts=${artifacts.length}`);
  }

  const planMerges = merges.filter((merge) => merge?.planId === FEATURE_MATRIX_PLAN_ID);
  if (depth >= 4) {
    const verified = planMerges.filter((merge) => merge.status === "verified");
    const expectedMergeShardIds = Array.isArray(plan?.shards)
      ? plan.shards.map((shard) => shard?.id).filter((id) => typeof id === "string")
      : [];
    const verifiedByShard = new Map(verified.map((merge) => [merge?.shardId, merge]));
    const orderedVerified = expectedMergeShardIds.map((shardId) => verifiedByShard.get(shardId));
    const verifiedCommitShas = orderedVerified.map((merge) => merge?.integrationCommitSha);
    const finalVerified = [...events].reverse().find((event) => event?.type === "merge_verified"
      && event?.planId === FEATURE_MATRIX_PLAN_ID);
    add("c4_merges_verified", merges.length === 2
      && expectedMergeShardIds.length === 2
      && new Set(expectedMergeShardIds).size === 2
      && verified.length === 2
      && verifiedByShard.size === 2
      && orderedVerified.every((merge) => merge
        && typeof merge.integrationCommitSha === "string"
        && /^[a-f0-9]{40}$/.test(merge.integrationCommitSha))
      && new Set(verifiedCommitShas).size === 2,
    verified.map((merge) => `${merge.shardId}:${merge.integrationCommitSha}`).join(", ") || "missing verified merges");
    const artifactByShard = new Map(artifacts.map((artifact) => [artifact?.shardId, artifact]));
    add("c4_merge_patch_provenance", orderedVerified.length === 2 && orderedVerified.every((merge) => {
      const artifact = artifactByShard.get(merge?.shardId);
      const content = artifact ? patchContents[artifact.path] : null;
      return merge?.gate?.allowlistOk === true
        && merge?.gate?.testsOk === true
        && artifact
        && normalizeEvidencePath(merge.patchArtifactPath) === normalizeEvidencePath(artifact.path)
        && typeof content === "string"
        && merge.patchSha256 === digest(content.trim());
    }), orderedVerified.map((merge) => `${merge?.shardId ?? "missing"}:${merge?.patchSha256 ?? "missing"}`).join(", "));
    const commitParents = input?.commitParents && typeof input.commitParents === "object" ? input.commitParents : {};
    const firstCommit = verifiedCommitShas[0];
    const secondCommit = verifiedCommitShas[1];
    add("c4_commit_chain_exact", typeof firstCommit === "string"
      && typeof secondCommit === "string"
      && Array.isArray(commitParents[firstCommit])
      && commitParents[firstCommit].length === 1
      && commitParents[firstCommit][0] === input?.seedHeadSha
      && Array.isArray(commitParents[secondCommit])
      && commitParents[secondCommit].length === 1
      && commitParents[secondCommit][0] === firstCommit,
    `${firstCommit ?? "missing"}<-${JSON.stringify(commitParents[firstCommit] ?? [])}; ${secondCommit ?? "missing"}<-${JSON.stringify(commitParents[secondCommit] ?? [])}`);
    const commitTreeProofs = Array.isArray(input?.commitTreeProofs) ? input.commitTreeProofs : [];
    const proofShardIds = commitTreeProofs.map((proof) => proof?.shardId);
    const proofCommitShas = commitTreeProofs.map((proof) => proof?.commitSha);
    const proofByShard = new Map(commitTreeProofs.map((proof) => [proof?.shardId, proof]));
    const orderedProofs = expectedMergeShardIds.map((shardId) => proofByShard.get(shardId));
    add("c4_commit_tree_proof_set_exact", commitTreeProofs.length === 2
      && new Set(proofShardIds).size === 2
      && new Set(proofCommitShas).size === 2
      && expectedMergeShardIds.every((shardId) => proofShardIds.includes(shardId))
      && orderedProofs.every((proof, index) => {
        const merge = orderedVerified[index];
        const artifact = artifactByShard.get(proof?.shardId);
        const expectedParent = index === 0 ? input?.seedHeadSha : orderedVerified[index - 1]?.integrationCommitSha;
        return proof?.method === "git-read-tree-apply-cached-write-tree"
          && proof?.commitSha === merge?.integrationCommitSha
          && proof?.parentSha === expectedParent
          && artifact
          && normalizeEvidencePath(proof?.patchArtifactPath) === normalizeEvidencePath(artifact.path)
          && proof?.patchSha256 === artifact.sha256
          && typeof patchContents[artifact.path] === "string"
          && proof.patchSha256 === digest(patchContents[artifact.path])
          && /^[a-f0-9]{40}$/.test(proof?.actualTreeSha ?? "")
          && /^[a-f0-9]{40}$/.test(proof?.expectedTreeSha ?? "");
      }),
    commitTreeProofs.map((proof) => `${proof?.shardId ?? "missing"}:${proof?.parentSha ?? "missing"}->${proof?.commitSha ?? "missing"}:${proof?.patchSha256 ?? "missing"}`).join(", ") || "missing proofs");
    add("c4_commit_trees_match_exact_patch_application", orderedProofs.length === 2
      && orderedProofs.every((proof) => proof
        && proof.actualTreeSha === proof.expectedTreeSha),
    orderedProofs.map((proof) => `${proof?.shardId ?? "missing"}:actual=${proof?.actualTreeSha ?? "missing"}:expected=${proof?.expectedTreeSha ?? "missing"}`).join(", "));
    add("c4_expected_files_delivered", input?.deliveredFiles?.["feature-a.txt"] === "alpha\n"
      && input?.deliveredFiles?.["feature-b.txt"] === "beta\n",
    `feature-a=${digest(input?.deliveredFiles?.["feature-a.txt"] ?? "missing")}; feature-b=${digest(input?.deliveredFiles?.["feature-b.txt"] ?? "missing")}`);
    add("c4_exact_delivered_sha", typeof input?.deliveredHeadSha === "string"
      && input.deliveredHeadSha.length === 40
      && finalVerified?.integrationCommitSha === input.deliveredHeadSha,
    `head=${input?.deliveredHeadSha ?? "missing"}; finalMerge=${finalVerified?.integrationCommitSha ?? "missing"}`);
  } else {
    add("c4_remains_disabled", planMerges.length === 0, `merges=${planMerges.length}`);
  }

  if (depth === 0) {
    const featureEventTypes = new Set([
      "subagent_started",
      "subagent_finished",
      "shard_plan_proposed",
      "shard_posted",
      "shard_claimed",
      "shard_completed",
      "shard_failed",
      "merge_proposed",
      "merge_verified",
    ]);
    const observedFeatureEvents = events.filter((event) => featureEventTypes.has(event?.type ?? event?.kind));
    add("off_inert_boundary_reached", ["implement", "validate"].includes(state?.phase),
      `phase=${state?.phase ?? "missing"}; status=${state?.status ?? "missing"}`);
    add("off_no_feature_events", observedFeatureEvents.length === 0,
      observedFeatureEvents.map((event) => event?.type ?? event?.kind).join(",") || "none");
    add("off_no_feature_artifacts", plans.length === 0
      && claims.length === 0
      && merges.length === 0
      && artifacts.length === 0
      && Object.keys(patchContents).length === 0,
    `plans=${plans.length}; claims=${claims.length}; merges=${merges.length}; artifacts=${artifacts.length}; patchContents=${Object.keys(patchContents).length}`);
    add("off_head_unchanged", typeof input?.seedHeadSha === "string"
      && input.seedHeadSha.length === 40
      && input?.deliveredHeadSha === input.seedHeadSha,
    `seed=${input?.seedHeadSha ?? "missing"}; head=${input?.deliveredHeadSha ?? "missing"}`);
    add("off_tracked_tree_clean", input?.trackedWorktreeStatus === "", `status=${input?.trackedWorktreeStatus || "clean"}`);
  }

  const failed = checks.filter((check) => !check.passed);
  return {
    schema: "pi-iterative-goal.production-feature-profile.v1",
    profile,
    enabledCampaigns: ["C1", "C2", "C3", "C4"].slice(0, depth),
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    failedCheckIds: failed.map((check) => check.id),
    eventTypeCounts: eventTypeCounts(events),
  };
}
