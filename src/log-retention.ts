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
export const PRODUCTION_EVIDENCE_SUCCESS_TTL_MS = 30 * 24 * 60 * 60_000;
export const PRODUCTION_EVIDENCE_FAILURE_TTL_MS = 90 * 24 * 60 * 60_000;
export const PRODUCTION_EVIDENCE_INCOMPLETE_TTL_MS = 14 * 24 * 60 * 60_000;
export const PRODUCTION_EVIDENCE_RUN_CAP_BYTES = 128 * 1024 * 1024;
export const TOTAL_PRODUCTION_EVIDENCE_CAP_BYTES = 512 * 1024 * 1024;
export const RECENT_PRODUCTION_SUCCESSES_TO_KEEP = 5;
export const RECENT_PRODUCTION_FAILURES_TO_KEEP = 10;

const PRODUCTION_EVIDENCE_NAMESPACES = [
  "prod-runtime-confirmation",
  "prod-feature-matrix",
] as const;
const EVIDENCE_CURRENT_GRACE_MS = RETENTION_INTERVAL_MS * 2;
const MAX_EVIDENCE_RESULT_BYTES = 1024 * 1024;

export interface RetentionDeletion {
  path: string;
  bytes: number;
  reason: "ttl" | "run_cap" | "total_cap" | "evidence_ttl" | "evidence_run_cap" | "evidence_total_cap";
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

type EvidenceStatus = "success" | "failure" | "incomplete";

interface EvidenceCandidate {
  absolute: string;
  relative: string;
  namespace: typeof PRODUCTION_EVIDENCE_NAMESPACES[number];
  runId: string;
  bytes: number;
  mtimeMs: number;
  status: EvidenceStatus;
  protectedReasons: Set<string>;
  keepRecent: boolean;
}

interface EvidenceInventory {
  candidates: EvidenceCandidate[];
  fixedBytes: number;
  issues: string[];
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

function liveEvidenceRunIds(root: string, nowMs: number): Set<string> {
  const live = liveRunIds(root, nowMs);
  const runsRoot = path.join(root, "runs");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(runsRoot, { withFileTypes: true }); }
  catch (error) {
    if (isMissing(error)) return live;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || live.has(entry.name)) continue;
    const marker = path.join(runsRoot, entry.name, "ACTIVE");
    try {
      const stat = fs.lstatSync(marker);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64) continue;
      const value = fs.readFileSync(marker, "utf8").trim();
      if (!/^[1-9][0-9]{0,9}$/.test(value)) continue;
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        live.add(entry.name);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM") live.add(entry.name);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isProtectedEvidenceName(name: string): boolean {
  return name === "owner.json"
    || name.endsWith(".head.json")
    || name === "PINNED"
    || name === "CURRENT"
    || name === "ACTIVE"
    || name === "heads"
    || name === "aggregates";
}

function evidenceResultStatus(runDirectory: string, namespace: EvidenceCandidate["namespace"]): EvidenceStatus {
  const resultPath = path.join(runDirectory, "results.json");
  try {
    const stat = fs.lstatSync(resultPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EVIDENCE_RESULT_BYTES) return "failure";
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    const status = namespace === "prod-feature-matrix" ? result.executionStatus : result.overall;
    return status === "PASS" ? "success" : "failure";
  } catch (error) {
    if (isMissing(error)) return "incomplete";
    return "failure";
  }
}

function inspectEvidenceDirectory(
  managedRoot: string,
  namespace: EvidenceCandidate["namespace"],
  absolute: string,
  activeRuns: Set<string>,
  nowMs: number,
): EvidenceCandidate {
  const runId = path.basename(absolute);
  const protectedReasons = new Set<string>();
  if (isProtectedEvidenceName(runId)) protectedReasons.add(`protected:${runId}`);
  let bytes = 0;
  let mtimeMs = 0;
  const walk = (directory: string, topLevel = false): void => {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`production evidence path is not a real directory: ${path.relative(managedRoot, directory)}`);
    }
    mtimeMs = Math.max(mtimeMs, directoryStat.mtimeMs);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) {
        throw new Error(`production evidence contains a symlink: ${path.relative(managedRoot, child)}`);
      }
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
      if (isProtectedEvidenceName(entry.name)) protectedReasons.add(`protected:${entry.name}`);
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) bytes += stat.size;
      else throw new Error(`production evidence contains a non-regular entry: ${path.relative(managedRoot, child)}`);
    }
    if (topLevel && activeRuns.has(runId)) protectedReasons.add("active-run");
  };
  walk(absolute, true);
  if (nowMs - mtimeMs < EVIDENCE_CURRENT_GRACE_MS) protectedReasons.add("fresh");
  return {
    absolute,
    relative: path.relative(managedRoot, absolute),
    namespace,
    runId,
    bytes,
    mtimeMs,
    status: evidenceResultStatus(absolute, namespace),
    protectedReasons,
    keepRecent: false,
  };
}

function inventoryProductionEvidence(
  managedRoot: string,
  activeRuns: Set<string>,
  nowMs: number,
): EvidenceInventory {
  const candidates: EvidenceCandidate[] = [];
  const issues: string[] = [];
  let fixedBytes = 0;
  const evidenceRoot = path.join(managedRoot, "evidence");
  try {
    const evidenceStat = fs.lstatSync(evidenceRoot);
    if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory()
      || fs.realpathSync(evidenceRoot) !== path.resolve(evidenceRoot)) {
      return {
        candidates,
        fixedBytes: evidenceStat.isFile() ? evidenceStat.size : 0,
        issues: [`production evidence root is not the exact owned directory: ${path.relative(managedRoot, evidenceRoot)}`],
      };
    }
  } catch (error) {
    if (isMissing(error)) return { candidates, fixedBytes, issues };
    throw error;
  }
  for (const namespace of PRODUCTION_EVIDENCE_NAMESPACES) {
    const namespaceRoot = path.join(evidenceRoot, namespace);
    let namespaceStat: fs.Stats;
    try { namespaceStat = fs.lstatSync(namespaceRoot); }
    catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (namespaceStat.isSymbolicLink() || !namespaceStat.isDirectory()) {
      issues.push(`production evidence namespace is not a real directory: ${path.relative(managedRoot, namespaceRoot)}`);
      if (namespaceStat.isFile()) fixedBytes += namespaceStat.size;
      continue;
    }
    const resolvedNamespace = fs.realpathSync(namespaceRoot);
    if (!isWithin(managedRoot, resolvedNamespace) || resolvedNamespace !== path.resolve(namespaceRoot)) {
      issues.push(`production evidence namespace is not the exact owned directory: ${path.relative(managedRoot, namespaceRoot)}`);
      continue;
    }
    for (const entry of fs.readdirSync(namespaceRoot, { withFileTypes: true })) {
      const absolute = path.join(namespaceRoot, entry.name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); }
      catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        issues.push(`unexpected production evidence entry retained: ${path.relative(managedRoot, absolute)}`);
        if (stat.isFile()) fixedBytes += stat.size;
        continue;
      }
      try { candidates.push(inspectEvidenceDirectory(managedRoot, namespace, absolute, activeRuns, nowMs)); }
      catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
        // Account for whatever can be measured without traversing symlinks.
        const measure = (directory: string): void => {
          for (const childEntry of fs.readdirSync(directory, { withFileTypes: true })) {
            const child = path.join(directory, childEntry.name);
            const childStat = fs.lstatSync(child);
            if (childStat.isSymbolicLink()) continue;
            if (childStat.isDirectory()) measure(child);
            else if (childStat.isFile()) fixedBytes += childStat.size;
          }
        };
        try { measure(absolute); } catch (measureError) {
          issues.push(`could not measure production evidence safely: ${measureError instanceof Error ? measureError.message : String(measureError)}`);
        }
      }
    }
  }

  for (const namespace of PRODUCTION_EVIDENCE_NAMESPACES) {
    const scoped = candidates.filter((candidate) => candidate.namespace === namespace)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.relative.localeCompare(a.relative));
    if (scoped[0]) scoped[0].protectedReasons.add("current");
    const successes = scoped.filter((candidate) => candidate.status === "success");
    const failures = scoped.filter((candidate) => candidate.status === "failure");
    for (const candidate of successes.slice(0, RECENT_PRODUCTION_SUCCESSES_TO_KEEP)) candidate.keepRecent = true;
    for (const candidate of failures.slice(0, RECENT_PRODUCTION_FAILURES_TO_KEEP)) candidate.keepRecent = true;
  }
  return { candidates, fixedBytes, issues };
}

function evidenceTtl(candidate: EvidenceCandidate): number {
  if (candidate.status === "success") return PRODUCTION_EVIDENCE_SUCCESS_TTL_MS;
  if (candidate.status === "failure") return PRODUCTION_EVIDENCE_FAILURE_TTL_MS;
  return PRODUCTION_EVIDENCE_INCOMPLETE_TTL_MS;
}

function removeEvidenceDirectory(managedRoot: string, candidate: EvidenceCandidate): void {
  if (!isWithin(managedRoot, candidate.absolute)) throw new Error(`production evidence path escapes managed root: ${candidate.relative}`);
  const resolvedParent = fs.realpathSync(path.dirname(candidate.absolute));
  if (!isWithin(managedRoot, resolvedParent) || resolvedParent !== path.resolve(path.dirname(candidate.absolute))) {
    throw new Error(`production evidence parent is not the exact owned directory: ${candidate.relative}`);
  }
  const preflight = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`refusing to purge evidence symlink: ${path.relative(managedRoot, target)}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        if (isProtectedEvidenceName(entry)) {
          throw new Error(`refusing to purge protected evidence: ${path.relative(managedRoot, path.join(target, entry))}`);
        }
        preflight(path.join(target, entry));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`refusing to purge non-regular evidence: ${path.relative(managedRoot, target)}`);
    if (isProtectedEvidenceName(path.basename(target))) {
      throw new Error(`refusing to purge protected evidence: ${path.relative(managedRoot, target)}`);
    }
  };
  const remove = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`refusing to purge evidence symlink: ${path.relative(managedRoot, target)}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) remove(path.join(target, entry));
      fs.rmdirSync(target);
      return;
    }
    if (!stat.isFile() || isProtectedEvidenceName(path.basename(target))) {
      throw new Error(`refusing to purge protected or non-regular evidence: ${path.relative(managedRoot, target)}`);
    }
    fs.unlinkSync(target);
  };
  preflight(candidate.absolute);
  remove(candidate.absolute);
}

function retainProductionEvidence(
  managedRoot: string,
  activeRuns: Set<string>,
  nowMs: number,
  deleted: RetentionDeletion[],
): string[] {
  const inventory = inventoryProductionEvidence(managedRoot, activeRuns, nowMs);
  const removed = new Set<string>();
  const reasons = inventory.issues.map((issue) => `unsafe production evidence retained: ${issue}`);
  const purge = (candidate: EvidenceCandidate, reason: RetentionDeletion["reason"]): void => {
    if (removed.has(candidate.absolute) || candidate.protectedReasons.size > 0) return;
    try {
      removeEvidenceDirectory(managedRoot, candidate);
      removed.add(candidate.absolute);
      deleted.push({ path: candidate.relative, bytes: candidate.bytes, reason });
    } catch (error) {
      candidate.protectedReasons.add("purge-race-or-error");
      reasons.push(`production evidence purge failed for ${candidate.relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const oldestFirst = [...inventory.candidates]
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.relative.localeCompare(b.relative));
  for (const candidate of oldestFirst) {
    if (candidate.protectedReasons.size > 0 || candidate.keepRecent) continue;
    if (nowMs - candidate.mtimeMs >= evidenceTtl(candidate)) purge(candidate, "evidence_ttl");
  }
  for (const candidate of oldestFirst) {
    if (removed.has(candidate.absolute) || candidate.protectedReasons.size > 0) continue;
    if (candidate.bytes > PRODUCTION_EVIDENCE_RUN_CAP_BYTES) purge(candidate, "evidence_run_cap");
  }

  let total = inventory.fixedBytes + inventory.candidates
    .filter((candidate) => !removed.has(candidate.absolute))
    .reduce((sum, candidate) => sum + candidate.bytes, 0);
  const capacityOrder = oldestFirst
    .filter((candidate) => !removed.has(candidate.absolute) && candidate.protectedReasons.size === 0)
    .sort((a, b) => {
      if (a.keepRecent !== b.keepRecent) return a.keepRecent ? 1 : -1;
      const priority: Record<EvidenceStatus, number> = { success: 0, incomplete: 1, failure: 2 };
      return priority[a.status] - priority[b.status] || a.mtimeMs - b.mtimeMs || a.relative.localeCompare(b.relative);
    });
  for (const candidate of capacityOrder) {
    if (total <= TOTAL_PRODUCTION_EVIDENCE_CAP_BYTES) break;
    purge(candidate, "evidence_total_cap");
    if (removed.has(candidate.absolute)) total -= candidate.bytes;
  }

  for (const candidate of inventory.candidates) {
    if (!removed.has(candidate.absolute) && candidate.bytes > PRODUCTION_EVIDENCE_RUN_CAP_BYTES) {
      reasons.push(`production evidence ${candidate.relative} bytes ${candidate.bytes} exceed run cap ${PRODUCTION_EVIDENCE_RUN_CAP_BYTES} (${[...candidate.protectedReasons].join(", ") || "not purgeable"})`);
    }
  }
  if (total > TOTAL_PRODUCTION_EVIDENCE_CAP_BYTES) {
    reasons.push(`production evidence bytes ${total} exceed cap ${TOTAL_PRODUCTION_EVIDENCE_CAP_BYTES}; active, current, pinned, or protected evidence was retained`);
  }
  return reasons;
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
  const activeEvidenceRuns = liveEvidenceRunIds(resolvedRoot, nowMs);
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

  const evidenceReasons = retainProductionEvidence(resolvedRoot, activeEvidenceRuns, nowMs, deleted);

  const freeBytes = freeDiskBytes(resolvedRoot);
  const reasons: string[] = [...evidenceReasons];
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
