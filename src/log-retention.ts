import * as fs from "node:fs";
import * as path from "node:path";
import { appendManagedLog, ensureManagedRoot, getManagedRoot } from "./logging.js";

export const RETENTION_INTERVAL_MS = 6 * 60_000;
export const SUCCESS_RAW_TTL_MS = 7 * 24 * 60 * 60_000;
export const FAILURE_RAW_TTL_MS = 14 * 24 * 60 * 60_000;
export const TELEMETRY_TTL_MS = 30 * 24 * 60 * 60_000;
export const RUN_RAW_CAP_BYTES = 250 * 1024 * 1024;
export const TOTAL_RAW_CAP_BYTES = 1024 * 1024 * 1024;
export const TOTAL_MANAGED_CAP_BYTES = 1024 * 1024 * 1024;
export const FREE_DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;

export interface RetentionDeletion {
  path: string;
  bytes: number;
  reason: "ttl" | "run_cap" | "total_cap";
}

export interface RetentionReport {
  checkedAt: string;
  managedRoot: string;
  deleted: RetentionDeletion[];
  bytesDeleted: number;
  managedBytesAfter: number;
  freeBytes: number | null;
  blocked: boolean;
  reasons: string[];
}

interface Candidate {
  absolute: string;
  relative: string;
  bytes: number;
  mtimeMs: number;
  runId: string | null;
  ttlMs: number | null;
}

let lastReport: RetentionReport | null = null;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readCandidates(root: string): Candidate[] {
  const candidates: Candidate[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      const relative = path.relative(root, absolute);
      if (relative === "owner.json" || relative.endsWith(".head.json") || /retention\.journal\.jsonl(?:\.\d+\.gz)?$/.test(relative)) continue;
      // Rotated/completed files are candidates. Run-scoped invocation JSONL
      // also becomes a candidate after its telemetry TTL; otherwise thousands
      // of small, never-rotated run files could evade the aggregate cap. Raw
      // run JSONL is included too so a SIGKILL cannot leave an active-name file
      // outside TTL/cap accounting forever; a fresh run ACTIVE marker protects
      // live writers below.
      const inactiveTelemetryJsonl = /(?:^|\/)telemetry\/invocations\/[^/]+\.jsonl$/.test(relative);
      const runRawJsonl = /(?:^|\/)runs\/[^/]+\/raw\/[^/]+\.jsonl$/.test(relative);
      if (!/\.gz$|\.completed\./.test(entry.name) && !inactiveTelemetryJsonl && !runRawJsonl) continue;
      if (/(?:^|\/)(?:evidence|state|receipts|aggregates)(?:\/|$)/.test(relative)) continue;
      let ttlMs: number | null = null;
      if (/(?:failed|debug|spool)/i.test(relative)) ttlMs = FAILURE_RAW_TTL_MS;
      else if (/(?:telemetry|invocations)/i.test(relative)) ttlMs = TELEMETRY_TTL_MS;
      else if (/(?:raw|success|logs|monitor)/i.test(relative)) ttlMs = SUCCESS_RAW_TTL_MS;
      const runMatch = relative.match(/(?:^|\/)runs\/([^/]+)\/raw\//);
      candidates.push({ absolute, relative, bytes: stat.size, mtimeMs: stat.mtimeMs, runId: runMatch?.[1] ?? null, ttlMs });
    }
  };
  walk(root);
  return candidates;
}

function liveRunIds(root: string, nowMs: number): Set<string> {
  const live = new Set<string>();
  const runsRoot = path.join(root, "runs");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(runsRoot, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return live;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = path.join(runsRoot, entry.name, "ACTIVE");
    try {
      const stat = fs.lstatSync(marker);
      if (!stat.isSymbolicLink() && stat.isFile() && nowMs - stat.mtimeMs < RETENTION_INTERVAL_MS * 2) {
        live.add(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return live;
}

function managedBytes(root: string): number {
  let total = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) total += stat.size;
    }
  };
  walk(root);
  return total;
}

function freeDiskBytes(root: string): number | null {
  try {
    const stats = fs.statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function runManagedLogRetention(cwd = process.cwd(), nowMs = Date.now()): RetentionReport {
  const root = ensureManagedRoot(cwd);
  const resolvedRoot = fs.realpathSync(root);
  const expectedRoot = fs.realpathSync(path.resolve(getManagedRoot(cwd)));
  if (resolvedRoot !== expectedRoot) {
    throw new Error(`Managed root realpath mismatch: ${resolvedRoot}`);
  }
  const owner = JSON.parse(fs.readFileSync(path.join(resolvedRoot, "owner.json"), "utf8")) as { owner?: unknown };
  if (owner.owner !== "pi-iterative-goal") throw new Error(`Managed root owner mismatch: ${resolvedRoot}`);

  const deleted: RetentionDeletion[] = [];
  const removed = new Set<string>();
  const activeRuns = liveRunIds(resolvedRoot, nowMs);
  const unlink = (candidate: Candidate, reason: RetentionDeletion["reason"]): void => {
    if (removed.has(candidate.absolute)) return;
    const resolvedParent = fs.realpathSync(path.dirname(candidate.absolute));
    if (!isWithin(resolvedRoot, candidate.absolute) || !isWithin(resolvedRoot, resolvedParent)) return;
    const stat = fs.lstatSync(candidate.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    fs.unlinkSync(candidate.absolute);
    // An expired active-name JSONL has a sidecar chain head. Remove that
    // exact owned sidecar with it so a future append cannot claim continuity
    // across bytes that retention intentionally expired.
    const headPath = `${candidate.absolute}.head.json`;
    if (fs.existsSync(headPath)) {
      const headStat = fs.lstatSync(headPath);
      if (headStat.isFile() && !headStat.isSymbolicLink() && isWithin(resolvedRoot, headPath)) fs.unlinkSync(headPath);
    }
    removed.add(candidate.absolute);
    deleted.push({ path: candidate.relative, bytes: stat.size, reason });
  };

  const candidates = readCandidates(resolvedRoot).sort((a, b) => a.mtimeMs - b.mtimeMs || a.relative.localeCompare(b.relative));
  for (const candidate of candidates) {
    if (!candidate.runId || !activeRuns.has(candidate.runId)) {
      if (candidate.ttlMs !== null && nowMs - candidate.mtimeMs >= candidate.ttlMs) unlink(candidate, "ttl");
    }
  }

  const remaining = candidates.filter((candidate) => !removed.has(candidate.absolute));
  // Never capacity-purge a file touched within two sweep cadences. It may be
  // the current writer even if a run lock is briefly unavailable; pressure
  // then blocks new telemetry instead of racing an active append.
  const capacityCandidates = remaining.filter((candidate) => (
    nowMs - candidate.mtimeMs >= RETENTION_INTERVAL_MS * 2
    && (!candidate.runId || !activeRuns.has(candidate.runId))
  ));
  const byRun = new Map<string, Candidate[]>();
  for (const candidate of capacityCandidates) {
    if (!candidate.runId) continue;
    const list = byRun.get(candidate.runId) ?? [];
    list.push(candidate);
    byRun.set(candidate.runId, list);
  }
  for (const files of byRun.values()) {
    let total = files.reduce((sum, item) => sum + item.bytes, 0);
    for (const candidate of files) {
      if (total <= RUN_RAW_CAP_BYTES) break;
      unlink(candidate, "run_cap");
      total -= candidate.bytes;
    }
  }

  let totalRaw = candidates.filter((candidate) => !removed.has(candidate.absolute)).reduce((sum, item) => sum + item.bytes, 0);
  for (const candidate of capacityCandidates) {
    if (totalRaw <= TOTAL_RAW_CAP_BYTES) break;
    if (removed.has(candidate.absolute)) continue;
    unlink(candidate, "total_cap");
    totalRaw -= candidate.bytes;
  }

  const freeBytes = freeDiskBytes(resolvedRoot);
  const reasons: string[] = [];
  const remainingRunBytes = new Map<string, number>();
  for (const candidate of candidates) {
    if (removed.has(candidate.absolute) || !candidate.runId) continue;
    remainingRunBytes.set(candidate.runId, (remainingRunBytes.get(candidate.runId) ?? 0) + candidate.bytes);
  }
  for (const [runId, bytes] of remainingRunBytes) {
    if (bytes > RUN_RAW_CAP_BYTES) reasons.push(`run ${runId} raw bytes ${bytes} exceed cap ${RUN_RAW_CAP_BYTES}`);
  }
  if (totalRaw > TOTAL_RAW_CAP_BYTES) reasons.push(`managed raw bytes ${totalRaw} exceed cap ${TOTAL_RAW_CAP_BYTES}`);
  if (freeBytes !== null && freeBytes < FREE_DISK_FLOOR_BYTES) reasons.push(`free disk bytes ${freeBytes} below floor ${FREE_DISK_FLOOR_BYTES}`);
  const managedBytesAfter = managedBytes(resolvedRoot);
  if (managedBytesAfter > TOTAL_MANAGED_CAP_BYTES) {
    reasons.push(`managed bytes ${managedBytesAfter} exceed cap ${TOTAL_MANAGED_CAP_BYTES}; protected evidence was retained`);
  }
  const report: RetentionReport = {
    checkedAt: new Date(nowMs).toISOString(),
    managedRoot: resolvedRoot,
    deleted,
    bytesDeleted: deleted.reduce((sum, item) => sum + item.bytes, 0),
    managedBytesAfter,
    freeBytes,
    blocked: reasons.length > 0,
    reasons,
  };
  lastReport = report;
  appendManagedLog("retention.journal", "retention", `retention_check deleted=${deleted.length} bytes=${report.bytesDeleted} blocked=${report.blocked}`, {
    cwd,
    level: report.blocked ? "error" : deleted.length > 0 ? "info" : "debug",
    metadata: { ...report, deleted: deleted.map((item) => ({ ...item })) },
  });
  return report;
}

export function getManagedLogHealth(): RetentionReport | null {
  return lastReport;
}

export function assertManagedLoggingHealthy(): void {
  if (lastReport?.blocked) throw new Error(`Managed logging storage pressure: ${lastReport.reasons.join("; ")}`);
}

function recordRetentionFailure(cwd: string, error: unknown): void {
  const reason = `retention sweep failed: ${error instanceof Error ? error.message : String(error)}`;
  lastReport = {
    checkedAt: new Date().toISOString(),
    managedRoot: getManagedRoot(cwd),
    deleted: [],
    bytesDeleted: 0,
    managedBytesAfter: 0,
    freeBytes: null,
    blocked: true,
    reasons: [reason],
  };
  try {
    appendManagedLog("retention.journal", "retention", reason, { cwd, level: "error" });
  } catch { /* health snapshot remains fail-closed even when logging is unavailable */ }
}

export function startManagedLogRetentionLoop(cwd = process.cwd(), intervalMs = RETENTION_INTERVAL_MS): () => void {
  try { runManagedLogRetention(cwd); } catch (error) { recordRetentionFailure(cwd, error); }
  // This is deliberately a self-scheduling timeout rather than another
  // interval ticker. The phase indicator remains the extension's sole
  // fixed-interval owner, while retention cannot overlap itself if a sweep is
  // unexpectedly slow.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      try { runManagedLogRetention(cwd); } catch (error) { recordRetentionFailure(cwd, error); }
      schedule();
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
