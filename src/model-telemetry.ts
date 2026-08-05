import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { appendManagedLog, ensureManagedRoot } from "./logging.js";
import { assertManagedLoggingHealthy } from "./log-retention.js";

export const MODEL_INVOCATION_SCHEMA = "pi-iterative-goal.model-invocation.v1" as const;
export const MODEL_COMPARISON_SCHEMA = "pi-iterative-goal.model-comparison.v1" as const;
export const MAX_TELEMETRY_FILES_PER_LOAD = 256;
export const MAX_TELEMETRY_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TELEMETRY_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
export const MAX_TELEMETRY_LINE_BYTES = 128 * 1024;
export const MAX_TELEMETRY_RECORDS_PER_LOAD = 100_000;

export type ModelTermination = "success" | "provider_error" | "timeout" | "cancelled" | "schema_error" | "gate_failure" | "budget_exhausted";

export interface ModelInvocationV1 {
  schema: typeof MODEL_INVOCATION_SCHEMA;
  invocationId: string;
  runId: string;
  sessionId: string | null;
  cycle: number | null;
  phase: string | null;
  phaseAttemptId: string | null;
  taskId: string | null;
  attempt: number;
  role: string;
  workloadClass: string;
  fixtureHash: string | null;
  routeId: string;
  provider: string;
  requestedModel: string;
  responseModel: string | null;
  familyId: string;
  servingVariant: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  fallbackReason: string | null;
  startedAt: string;
  firstTokenAt: string | null;
  endedAt: string;
  latencyMs: number;
  ttftMs: number | null;
  outputTokensPerSecond: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
  costUsd: number | null;
  turns: number;
  toolCallCount: number;
  toolErrorCount: number;
  termination: ModelTermination;
  gateStatus: "PASS" | "FAIL" | "NOT_RUN";
  errorCode: string | null;
  requestDigest: string | null;
  resultDigest: string | null;
}

export interface ModelComparisonV1 {
  schema: typeof MODEL_COMPARISON_SCHEMA;
  generatedAt: string;
  workloadClass: string;
  fixtureHash: string | null;
  routeId: string;
  sampleCount: number;
  comparisonRouteCount: number;
  gatedSampleCount: number;
  sufficientData: boolean;
  successRate: number;
  gatePassRate: number | null;
  schemaErrorRate: number;
  retryOrFallbackRate: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  medianTtftMs: number | null;
  p95TtftMs: number | null;
  medianOutputTokensPerSecond: number | null;
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  medianCostUsd: number | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function recordModelInvocation(
  invocation: Omit<ModelInvocationV1, "schema">,
  cwd = process.cwd(),
): ModelInvocationV1 {
  assertManagedLoggingHealthy();
  const normalized: ModelInvocationV1 = {
    schema: MODEL_INVOCATION_SCHEMA,
    ...invocation,
    latencyMs: finiteOrNull(invocation.latencyMs) ?? 0,
    ttftMs: finiteOrNull(invocation.ttftMs),
    outputTokensPerSecond: finiteOrNull(invocation.outputTokensPerSecond),
    inputTokens: finiteOrNull(invocation.inputTokens) ?? 0,
    outputTokens: finiteOrNull(invocation.outputTokens) ?? 0,
    cacheReadTokens: finiteOrNull(invocation.cacheReadTokens) ?? 0,
    cacheWriteTokens: finiteOrNull(invocation.cacheWriteTokens) ?? 0,
    reasoningTokens: finiteOrNull(invocation.reasoningTokens),
    costUsd: finiteOrNull(invocation.costUsd),
    turns: finiteOrNull(invocation.turns) ?? 0,
    toolCallCount: finiteOrNull(invocation.toolCallCount) ?? 0,
    toolErrorCount: finiteOrNull(invocation.toolErrorCount) ?? 0,
  };
  const root = ensureManagedRoot(cwd);
  const safeRunId = invocation.runId.replace(/[^A-Za-z0-9._-]/g, "-");
  appendManagedLog("model-invocations", "model-telemetry", "model invocation completed", {
    cwd,
    runId: invocation.runId,
    phaseAttemptId: invocation.phaseAttemptId,
    level: invocation.termination === "success" ? "info" : "warn",
    metadata: normalized as unknown as Record<string, unknown>,
    required: true,
    path: path.join(root, "telemetry", "invocations", `${safeRunId}.jsonl`),
  });
  return normalized;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function compareModelInvocations(invocations: ModelInvocationV1[], minimumSamples = 5): ModelComparisonV1[] {
  const groups = new Map<string, ModelInvocationV1[]>();
  for (const item of invocations) {
    const key = `${item.workloadClass}\u0000${item.fixtureHash ?? ""}\u0000${item.routeId}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const comparableRouteCounts = new Map<string, number>();
  for (const items of groups.values()) {
    const first = items[0];
    const fixtureKey = `${first.workloadClass}\u0000${first.fixtureHash ?? ""}`;
    if (first.fixtureHash !== null && items.length >= minimumSamples) {
      comparableRouteCounts.set(fixtureKey, (comparableRouteCounts.get(fixtureKey) ?? 0) + 1);
    }
  }
  return [...groups.values()].map((items) => {
    const first = items[0];
    const ratio = (predicate: (item: ModelInvocationV1) => boolean): number => items.filter(predicate).length / items.length;
    const numbers = (pick: (item: ModelInvocationV1) => number | null): number[] => items.map(pick).filter((value): value is number => value !== null && Number.isFinite(value));
    const gated = items.filter((item) => item.gateStatus !== "NOT_RUN");
    const fixtureKey = `${first.workloadClass}\u0000${first.fixtureHash ?? ""}`;
    const comparisonRouteCount = first.fixtureHash === null ? 0 : comparableRouteCounts.get(fixtureKey) ?? 0;
    return {
      schema: MODEL_COMPARISON_SCHEMA,
      generatedAt: new Date().toISOString(),
      workloadClass: first.workloadClass,
      fixtureHash: first.fixtureHash,
      routeId: first.routeId,
      sampleCount: items.length,
      comparisonRouteCount,
      gatedSampleCount: gated.length,
      sufficientData: items.length >= minimumSamples && comparisonRouteCount >= 2,
      successRate: ratio((item) => item.termination === "success"),
      gatePassRate: gated.length === 0 ? null : gated.filter((item) => item.gateStatus === "PASS").length / gated.length,
      schemaErrorRate: ratio((item) => item.termination === "schema_error"),
      retryOrFallbackRate: ratio((item) => item.attempt > 1 || item.fallbackReason !== null),
      medianLatencyMs: median(numbers((item) => item.latencyMs)),
      p95LatencyMs: percentile(numbers((item) => item.latencyMs), 0.95),
      medianTtftMs: median(numbers((item) => item.ttftMs)),
      p95TtftMs: percentile(numbers((item) => item.ttftMs), 0.95),
      medianOutputTokensPerSecond: median(numbers((item) => item.outputTokensPerSecond)),
      medianInputTokens: median(numbers((item) => item.inputTokens)),
      medianOutputTokens: median(numbers((item) => item.outputTokens)),
      medianCostUsd: median(numbers((item) => item.costUsd)),
    };
  }).sort((a, b) => a.workloadClass.localeCompare(b.workloadClass) || a.routeId.localeCompare(b.routeId));
}

function readBoundedRegularFile(filePath: string): Buffer {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Telemetry input is not a regular file: ${filePath}`);
    if (stat.size > MAX_TELEMETRY_FILE_BYTES) {
      throw new Error(`Telemetry input exceeds the ${MAX_TELEMETRY_FILE_BYTES}-byte per-file bound: ${filePath}`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return offset === bytes.length ? bytes : bytes.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonLines(filePath: string, remainingDecompressedBytes: number, remainingRecords: number): {
  values: unknown[];
  decompressedBytes: number;
} {
  const bytes = readBoundedRegularFile(filePath);
  let contentBytes: Buffer;
  if (filePath.endsWith(".gz")) {
    try {
      contentBytes = zlib.gunzipSync(bytes, { maxOutputLength: remainingDecompressedBytes });
    } catch (error) {
      throw new Error(`Telemetry gzip is invalid or exceeds the remaining decompression bound: ${filePath}`, { cause: error });
    }
  } else {
    if (bytes.length > remainingDecompressedBytes) {
      throw new Error(`Telemetry inputs exceed the ${MAX_TELEMETRY_DECOMPRESSED_BYTES}-byte load bound`);
    }
    contentBytes = bytes;
  }
  if (contentBytes.length > remainingDecompressedBytes) {
    throw new Error(`Telemetry inputs exceed the ${MAX_TELEMETRY_DECOMPRESSED_BYTES}-byte load bound`);
  }
  const content = contentBytes.toString("utf8");
  const values: unknown[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= content.length; cursor += 1) {
    if (cursor < content.length && content.charCodeAt(cursor) !== 10) continue;
    const rawLine = content.slice(start, cursor);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    start = cursor + 1;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_TELEMETRY_LINE_BYTES) {
      throw new Error(`Telemetry line exceeds the ${MAX_TELEMETRY_LINE_BYTES}-byte bound: ${filePath}`);
    }
    if (values.length >= remainingRecords) {
      throw new Error(`Telemetry inputs exceed the ${MAX_TELEMETRY_RECORDS_PER_LOAD}-record load bound`);
    }
    try {
      const envelope = JSON.parse(line) as { metadata?: unknown };
      values.push(envelope.metadata ?? envelope);
    } catch { /* malformed telemetry is excluded and remains visible in the source log */ }
  }
  return { values, decompressedBytes: contentBytes.length };
}

export function loadModelInvocations(cwd = process.cwd(), runId?: string): ModelInvocationV1[] {
  const directory = path.join(ensureManagedRoot(cwd), "telemetry", "invocations");
  if (!fs.existsSync(directory)) return [];
  const safeRunId = runId?.replace(/[^A-Za-z0-9._-]/g, "-");
  const inputs = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => (!safeRunId || entry.name.startsWith(`${safeRunId}.jsonl`)) && /\.jsonl(?:\.\d+\.gz)?$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(filePath);
      if (entry.isSymbolicLink() || stat.isSymbolicLink() || !entry.isFile() || !stat.isFile()) {
        throw new Error(`Telemetry input is not a real regular file: ${filePath}`);
      }
      return { filePath, name: entry.name, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  if (inputs.length > MAX_TELEMETRY_FILES_PER_LOAD) {
    throw new Error(`Telemetry load selected ${inputs.length} files; maximum is ${MAX_TELEMETRY_FILES_PER_LOAD}. Supply a runId or purge expired logs.`);
  }
  let decompressedBytes = 0;
  const values: unknown[] = [];
  for (const input of inputs) {
    const parsed = readJsonLines(
      input.filePath,
      MAX_TELEMETRY_DECOMPRESSED_BYTES - decompressedBytes,
      MAX_TELEMETRY_RECORDS_PER_LOAD - values.length,
    );
    decompressedBytes += parsed.decompressedBytes;
    values.push(...parsed.values);
  }
  return values.filter((item): item is ModelInvocationV1 => Boolean(
    item && typeof item === "object" && (item as { schema?: unknown }).schema === MODEL_INVOCATION_SCHEMA,
  ));
}

export function writeModelComparisonReport(cwd = process.cwd(), runId?: string, minimumSamples = 5): string {
  const root = ensureManagedRoot(cwd);
  const comparisons = compareModelInvocations(loadModelInvocations(cwd, runId), minimumSamples);
  const safeRunId = (runId ?? "all").replace(/[^A-Za-z0-9._-]/g, "-");
  const output = path.join(root, "telemetry", "aggregates", `${safeRunId}.model-comparison.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, JSON.stringify({ schema: MODEL_COMPARISON_SCHEMA, runId: runId ?? null, comparisons }, null, 2), { mode: 0o600 });
  return output;
}
