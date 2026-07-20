/**
 * Worktree lifecycle + merge-back layer (deployment plan Ch. 6 §6.6, Campaign 4).
 *
 * The isolated-worktree primitive exists exactly once in the repository — it
 * was promoted here from src/agents/pool.ts (prepareIsolatedWorktree:
 * `git worktree add --detach` into a temp dir, `git diff --binary` patch
 * capture, process-exit cleanup registry; cleanup extracted into
 * removeWorktree, behavior identical) — and extended into a proper lifecycle
 * module:
 *
 *   - recoverWorktrees: SCOPED crash recovery (C4-ADV-004/C4-ADV-010). Two
 *     classes, harness-prefix-confined (pi-ig-agent-*, pi-ig-integration-*)
 *     so user ad-hoc worktrees and other tools' registrations are never
 *     touched: (a) registrations whose directories VANISHED (plain prune
 *     territory — a crashed process cannot run its in-memory cleanup
 *     registry), and (b) registrations whose directories SURVIVE from a dead
 *     creator (the realistic kill -9 case — a PID marker file written at
 *     creation decides liveness; alive or unmarked worktrees are left alone).
 *     Production caller: run restore (src/kernel/lifecycle.ts session_start).
 *   - mergeShardPlan: patch application onto a harness-owned integration
 *     branch in HEFT order (rank from the ledgered claims; input rank is only
 *     an explicit override), behind the iterativeGoal.mergeBack feature flag.
 *     Isolation defers conflicts to merge time rather than eliminating them
 *     (§6.6), so verification concentrates here: every completed shard's
 *     captured patch passes a gate before it lands — (1) per-shard allowlist
 *     verify (src/workspace/change-set.ts → verifyShardPatchAgainstScope,
 *     git-native and fail-closed), (2) the repository test suite on the
 *     merged tree, and (3) the extended unfinished-work gate
 *     (src/evaluator.ts → findUnfinishedWork), recorded as a post-verdict
 *     evidence snapshot here and ENFORCED at goal time by the evaluator
 *     (rejecting shard i because shard j has not merged yet would deadlock
 *     the fan-out — completion is the evaluator's gate, not the merge
 *     layer's). A completed shard emits merge_proposed; gate pass emits
 *     merge_verified; gate rejection returns the shard to claimed with the
 *     failure evidence attached (Figure D5: merge_proposed → failed →
 *     claimed — the repair loop transition; repair re-DISPATCH stays a
 *     scheduler concern, not this layer's).
 *
 * Integration branch strategy: one harness-owned local branch per run
 * (pi-ig/integration/<runId>, overridable — overrides must keep the pi-ig/
 * prefix and must not name an existing non-harness branch, C4-ADV-009), cut
 * from HEAD at first merge. Verified patches land as one commit per shard,
 * staging ONLY the patch's own file list (never bare `git add -A`,
 * C4-ADV-005), authored via per-command `-c user.name/-c user.email` so
 * repository config is never mutated and hooks still run. The integration
 * worktree is reused when one already tracks the branch (kill -9 leaves it
 * behind — fataling on "already used by worktree" would wedge every
 * subsequent merge) and removed after each batch; the branch keeps the
 * verified work.
 *
 * Patch application is 2-way only, deliberately (C4-ADV-013): shard patches
 * are captured from worktrees cut at the same HEAD the integration branch is
 * cut from, and merges run in one batch immediately after execution. A base
 * that went stale in between means HEAD moved mid-run — merging onto moved
 * ground would invalidate the batch's provenance, so that case SHOULD
 * reject (and does, at the apply gate) rather than silently 3-way merging.
 *
 * Gate part 2 runs in a FRESH worktree: the configured testCommand must work
 * there. npm-family commands short-circuit with a bootstrap-required message
 * when package.json declares dependencies but node_modules is absent
 * (C4-ADV-006) — configure testCommand to bootstrap (e.g. "npm ci &&
 * npm test") or vendor dependencies.
 *
 * Rollback (flag off, §8.7): mergeShardPlan refuses before touching anything
 * — patches keep surfacing as [ISOLATED_WORKTREE_PATCH] blocks for manual
 * application (pre-C4 behavior), and the evaluator's gate extension is
 * flag-guarded off.
 */

import { execFileSync, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ShardMergeRecord, ShardPlan } from "../domain/shard.js";
import { shardDispatchTaskId } from "../domain/shard.js";
import { readIterativeGoalSettings } from "../domain/project-settings.js";
import { logDebug } from "../logging.js";
import type { StateManagerAPI } from "../state.js";
import { verifyShardPatchAgainstScope } from "./change-set.js";

function log(msg: string) {
  logDebug("worktrees", msg);
}

// ── Isolated worktree primitive (promoted from src/agents/pool.ts) ────

export interface IsolatedWorkspace {
  path: string;
  /** Complete base→filesystem binary patch, including staged, committed, and untracked work. */
  capturePatch(): string;
  /** Immutable source commit from which the worker worktree was created. */
  baseSha: string;
  cleanup(): void;
}

/**
 * PID marker written into every harness worktree at creation: recoverWorktrees
 * reclaims surviving directories only when their creator is provably dead
 * (kill -9 case), and never touches alive or unmarked worktrees (concurrent
 * runs, foreign provenance). Untracked, so it never enters a captured patch.
 */
const WORKTREE_MARKER_FILE = ".pi-ig-worktree.json";
const WORKTREE_MARKER_SCHEMA = "pi-iterative-goal.worktree-owner.v2";
const INTEGRATION_LEASE_SCHEMA = "pi-iterative-goal.integration-lease.v1";

interface WorktreeOwnerRecord {
  schema: typeof WORKTREE_MARKER_SCHEMA;
  pid: number;
  processStartToken: string | null;
  kind: "shard" | "integration";
  createdAt: string;
  branch?: string;
  leaseNonce?: string;
}

interface IntegrationLeaseRecord {
  schema: typeof INTEGRATION_LEASE_SCHEMA;
  repoRoot: string;
  branch: string;
  pid: number;
  processStartToken: string | null;
  nonce: string;
  acquiredAt: string;
}

interface IntegrationLease {
  path: string;
  record: IntegrationLeaseRecord;
  /** Dead lease atomically displaced during acquisition, if any. */
  predecessor: IntegrationLeaseRecord | null;
}

function processStartToken(pid: number): string | null {
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeWorktreeMarker(
  worktreePath: string,
  kind: "shard" | "integration",
  lease?: IntegrationLease,
  required = false,
): void {
  try {
    const record: WorktreeOwnerRecord = {
      schema: WORKTREE_MARKER_SCHEMA,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      kind,
      createdAt: new Date().toISOString(),
      ...(lease ? { branch: lease.record.branch, leaseNonce: lease.record.nonce } : {}),
    };
    const markerPath = path.join(worktreePath, WORKTREE_MARKER_FILE);
    const temporary = `${markerPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, markerPath);
  } catch (err) {
    if (required) throw err;
    log(`worktree marker write failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readWorktreeMarker(worktreePath: string): Partial<WorktreeOwnerRecord> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(worktreePath, WORKTREE_MARKER_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Partial<WorktreeOwnerRecord> : null;
  } catch {
    return null;
  }
}

export function prepareIsolatedWorktree(repoRoot: string, taskId: string): IsolatedWorkspace {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 }).trim();
  const safeId = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  const workspacePath = path.join(os.tmpdir(), `pi-ig-agent-${safeId}-${crypto.randomBytes(4).toString("hex")}`);
  execFileSync("git", ["worktree", "add", "--detach", workspacePath, baseSha], { cwd: repoRoot, stdio: "ignore" });
  const workspaceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  if (workspaceHead !== baseSha) {
    removeWorktree(repoRoot, workspacePath);
    throw new Error(`isolated worktree HEAD mismatch: expected ${baseSha}, got ${workspaceHead}`);
  }
  registerWorktreeForCleanup(repoRoot, workspacePath);
  writeWorktreeMarker(workspacePath, "shard");
  return {
    path: workspacePath,
    baseSha,
    capturePatch() {
      // A plain `git diff` omits untracked files and every change already
      // committed by the worker. Build a temporary index from the immutable
      // source base, stage the filesystem snapshot into that index, remove
      // the harness marker, and diff the index against the base. The worker's
      // real index/branch is never modified.
      const tempIndex = path.join(os.tmpdir(), `pi-ig-index-${safeId}-${crypto.randomBytes(4).toString("hex")}`);
      const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
      try {
        execFileSync("git", ["read-tree", baseSha], { cwd: workspacePath, env, stdio: "ignore", timeout: 30_000 });
        execFileSync("git", ["add", "-A", "--", "."], { cwd: workspacePath, env, stdio: "ignore", timeout: 30_000 });
        execFileSync("git", ["rm", "--cached", "--ignore-unmatch", "--", WORKTREE_MARKER_FILE], {
          cwd: workspacePath,
          env,
          stdio: "ignore",
          timeout: 30_000,
        });
        return execFileSync("git", ["diff", "--cached", "--binary", "--full-index", baseSha, "--"], {
          cwd: workspacePath,
          env,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 100 * 1024 * 1024,
        }).trim();
      } finally {
        try { fs.unlinkSync(tempIndex); } catch {}
        try { fs.unlinkSync(`${tempIndex}.lock`); } catch {}
      }
    },
    cleanup() {
      removeWorktree(repoRoot, workspacePath);
    },
  };
}

const pendingWorktreeCleanups = new Map<string, string>();
let cleanupHandlersRegistered = false;

function registerWorktreeForCleanup(repoRoot: string, workspacePath: string): void {
  pendingWorktreeCleanups.set(workspacePath, repoRoot);
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  const cleanupAll = () => {
    for (const [workspace, root] of pendingWorktreeCleanups.entries()) {
      removeWorktree(root, workspace);
    }
  };
  process.once("beforeExit", cleanupAll);
  process.once("exit", cleanupAll);
}

function unregisterWorktreeForCleanup(_repoRoot: string, workspacePath: string): void {
  pendingWorktreeCleanups.delete(workspacePath);
}

function removeWorktree(repoRoot: string, workspacePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", workspacePath], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
  } catch {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch {}
  }
  unregisterWorktreeForCleanup(repoRoot, workspacePath);
}

// ── Crash recovery (§6.6, §8.7) ──────────────────────────────────────

export interface WorktreeRecoveryReport {
  /** Registered worktree paths before recovery (main worktree included). */
  before: string[];
  after: string[];
  /** Harness registrations removed because their directories vanished. */
  pruned: string[];
  /** Harness registrations removed although their directories survived — the creating process is provably dead (kill -9 case). */
  reclaimed: string[];
  /** Non-harness registrations deliberately left alone (scoped recovery, C4-ADV-010). */
  skippedForeign: string[];
}

/** Harness worktree basename prefixes — recovery is confined to exactly these. */
export const HARNESS_WORKTREE_PREFIXES = ["pi-ig-agent-", "pi-ig-integration-"] as const;

function isHarnessWorktreePath(worktreePath: string): boolean {
  const base = path.basename(worktreePath);
  return HARNESS_WORKTREE_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function listWorktreePaths(repoRoot: string): string[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  return out.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours; ESRCH means dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type OwnerStatus = "live" | "dead" | "ambiguous";

function ownerStatus(record: { pid?: unknown; processStartToken?: unknown }): OwnerStatus {
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0
    ? record.pid
    : null;
  if (pid === null) return "ambiguous";
  if (!pidAlive(pid)) return "dead";
  const expected = typeof record.processStartToken === "string" && record.processStartToken.length > 0
    ? record.processStartToken
    : null;
  const actual = processStartToken(pid);
  if (!expected || !actual) return "ambiguous";
  return expected === actual ? "live" : "dead"; // PID was reused; the recorded owner is gone.
}

function gitCommonDir(repoRoot: string): string {
  const configured = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  return fs.realpathSync(path.resolve(repoRoot, configured));
}

function integrationLeaseRoot(repoRoot: string): string {
  const leaseRoot = path.join(gitCommonDir(repoRoot), "pi-iterative-goal", "integration-leases");
  fs.mkdirSync(leaseRoot, { recursive: true, mode: 0o700 });
  return leaseRoot;
}

function integrationLeasePath(repoRoot: string, branch: string): string {
  const leaseRoot = integrationLeaseRoot(repoRoot);
  return path.join(leaseRoot, `${sha256Text(branch)}.json`);
}

function readIntegrationLease(leasePath: string): IntegrationLeaseRecord | null {
  try {
    const stat = fs.lstatSync(leasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(leasePath, "utf8")) as Partial<IntegrationLeaseRecord>;
    if (parsed.schema !== INTEGRATION_LEASE_SCHEMA
      || typeof parsed.repoRoot !== "string"
      || typeof parsed.branch !== "string"
      || typeof parsed.pid !== "number"
      || typeof parsed.nonce !== "string"
      || typeof parsed.acquiredAt !== "string"
      || !(typeof parsed.processStartToken === "string" || parsed.processStartToken === null)) return null;
    return parsed as IntegrationLeaseRecord;
  } catch {
    return null;
  }
}

/**
 * Serializes lease create/reclaim/release. A surviving guard is intentionally
 * fail-closed: it denotes a crash in the tiny ownership transition window and
 * must never be guessed away while another process could be acquiring.
 */
function withIntegrationLeaseGuard<T>(leasePath: string, operation: () => T): T {
  const guardPath = `${leasePath}.guard`;
  try {
    fs.mkdirSync(guardPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`integration lease ownership is ambiguous (guard exists): ${leasePath}`);
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    try { fs.rmdirSync(guardPath); } catch (error) {
      log(`integration lease guard cleanup failed for ${guardPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function acquireIntegrationLease(repoRoot: string, branch: string): IntegrationLease {
  const resolvedRepo = fs.realpathSync(repoRoot);
  const leasePath = integrationLeasePath(resolvedRepo, branch);
  return withIntegrationLeaseGuard(leasePath, () => {
    let predecessor: IntegrationLeaseRecord | null = null;
    if (fs.existsSync(leasePath)) {
      const existing = readIntegrationLease(leasePath);
      if (!existing
        || existing.repoRoot !== resolvedRepo
        || existing.branch !== branch) {
        throw new Error(`integration lease ownership is ambiguous: ${leasePath}`);
      }
      const status = ownerStatus(existing);
      if (status !== "dead") {
        throw new Error(`integration branch ${branch} has a ${status} lease owner (pid ${existing.pid}); refusing concurrent reuse`);
      }
      // The branch-scoped guard makes dead-owner replacement atomic across all
      // harness processes. No contender can unlink a newly-created lease.
      predecessor = existing;
      fs.unlinkSync(leasePath);
    }
    const record: IntegrationLeaseRecord = {
      schema: INTEGRATION_LEASE_SCHEMA,
      repoRoot: resolvedRepo,
      branch,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      nonce: crypto.randomBytes(16).toString("hex"),
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(leasePath, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return { path: leasePath, record, predecessor };
  });
}

function releaseIntegrationLease(lease: IntegrationLease, restorePredecessor = false): void {
  try {
    withIntegrationLeaseGuard(lease.path, () => {
      if (!fs.existsSync(lease.path)) return;
      const current = readIntegrationLease(lease.path);
      if (!current || current.nonce !== lease.record.nonce) {
        throw new Error(`integration lease nonce mismatch; refusing to release ${lease.path}`);
      }
      fs.unlinkSync(lease.path);
      if (restorePredecessor && lease.predecessor) {
        fs.writeFileSync(lease.path, JSON.stringify(lease.predecessor), { flag: "wx", mode: 0o600 });
      }
    });
  } catch (error) {
    log(`integration lease release failed for ${lease.record.branch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function matchingIntegrationLease(repoRoot: string, marker: Partial<WorktreeOwnerRecord>): IntegrationLease | null {
  if (marker.schema !== WORKTREE_MARKER_SCHEMA
    || marker.kind !== "integration"
    || typeof marker.branch !== "string"
    || typeof marker.leaseNonce !== "string") return null;
  const leasePath = integrationLeasePath(repoRoot, marker.branch);
  const record = readIntegrationLease(leasePath);
  if (!record || record.nonce !== marker.leaseNonce || record.branch !== marker.branch) return null;
  return { path: leasePath, record, predecessor: null };
}

function recoverDeadIntegrationLeases(repoRoot: string): void {
  const resolvedRepo = fs.realpathSync(repoRoot);
  const leaseRoot = integrationLeaseRoot(resolvedRepo);
  for (const entry of fs.readdirSync(leaseRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const leasePath = path.join(leaseRoot, entry.name);
    const candidate = readIntegrationLease(leasePath);
    if (!candidate || candidate.repoRoot !== resolvedRepo || ownerStatus(candidate) !== "dead") continue;
    try {
      withIntegrationLeaseGuard(leasePath, () => {
        const current = readIntegrationLease(leasePath);
        if (!current
          || current.nonce !== candidate.nonce
          || current.repoRoot !== resolvedRepo
          || ownerStatus(current) !== "dead") return;
        fs.unlinkSync(leasePath);
      });
    } catch (error) {
      log(`dead integration lease recovery refused for ${leasePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Scoped crash recovery (C4-ADV-004/C4-ADV-010): reclaims only HARNESS-prefixed
 * worktree registrations — never the user's ad-hoc worktrees, never other
 * tools' registrations, never a concurrent run's live worktree. Two classes:
 * directories that vanished (a crashed process cannot run its cleanup
 * registry) and directories that SURVIVED a provably dead creator (kill -9;
 * the PID marker decides). Production caller: run restore
 * (src/kernel/lifecycle.ts session_start), exception-contained there.
 */
export function recoverWorktrees(repoRoot: string): WorktreeRecoveryReport {
  const before = listWorktreePaths(repoRoot);
  const pruned: string[] = [];
  const reclaimed: string[] = [];
  const skippedForeign: string[] = [];
  for (const entry of before) {
    if (!isHarnessWorktreePath(entry)) {
      skippedForeign.push(entry);
      continue;
    }
    if (!fs.existsSync(entry)) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", entry], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
        pruned.push(entry);
      } catch (err) {
        log(`scoped prune of ${entry} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    const marker = readWorktreeMarker(entry);
    const markerStatus = marker ? ownerStatus(marker) : "ambiguous";
    const integrationLease = marker?.kind === "integration"
      ? matchingIntegrationLease(repoRoot, marker)
      : null;
    const integrationLeaseDead = integrationLease ? ownerStatus(integrationLease.record) === "dead" : false;
    const reclaimable = markerStatus === "dead"
      && (marker?.kind !== "integration" || integrationLeaseDead);
    if (reclaimable) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", entry], { cwd: repoRoot, stdio: "ignore", timeout: 30_000 });
        if (integrationLease) releaseIntegrationLease(integrationLease);
        reclaimed.push(entry);
      } catch (err) {
        log(`reclaim of ${entry} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Live/ambiguous owner or an integration marker without its exact lease →
    // left alone. Recovery never guesses ownership from a writable path.
  }
  // A crashed process can lose the worktree directory before Git's stale
  // registration is pruned. Reclaim its exact dead-owner lease independently;
  // live and ambiguous lease records remain untouched.
  recoverDeadIntegrationLeases(repoRoot);
  const after = listWorktreePaths(repoRoot);
  return { before, after, pruned, reclaimed, skippedForeign };
}

// ── Feature flag + tuning (.pi/settings.json → iterativeGoal.mergeBack) ──

export interface MergeBackConfig {
  /**
   * Merge-back rollback flag (§8.7): disabled by default — captured patches
   * keep surfacing as [ISOLATED_WORKTREE_PATCH] blocks for manual
   * application, and the evaluator's merge_verified gate extension stays
   * inert (flag-guarded in src/evaluator.ts → findUnfinishedWork).
   */
  enabled: boolean;
  /**
   * Delivery flag: after every shard in the plan is merge_verified, prove the
   * ledgered commit chain and compare-and-swap the originally attached source
   * ref to that exact SHA. Disabled by default so integration-only behavior
   * remains unchanged.
   */
  promoteToSource: boolean;
  /**
   * Integration branch override; null → pi-ig/integration/<runId>. Overrides
   * must keep the pi-ig/ harness prefix (C4-ADV-009) — anything else is
   * ignored loudly and the derived name is used.
   */
  integrationBranch: string | null;
  /**
   * Repository test suite command run on the merged tree (gate part 2), in a
   * FRESH worktree: it must bootstrap its own dependencies (e.g. "npm ci &&
   * npm test") or the repo must vendor them. npm-family commands fail with a
   * bootstrap-required message when package.json declares dependencies but
   * node_modules is absent (C4-ADV-006).
   */
  testCommand: string;
  testTimeoutMs: number;
}

export const DEFAULT_MERGE_TEST_COMMAND = "npm test";
export const DEFAULT_MERGE_TEST_TIMEOUT_MS = 120_000;
/** Harness confinement for integration branches (C4-ADV-009). */
export const INTEGRATION_BRANCH_PREFIX = "pi-ig/";
/** Per-command commit identity for shard merge commits (never repo config). */
export const MERGE_COMMIT_AUTHOR = { name: "pi-iterative-goal", email: "pi-iterative-goal@localhost" } as const;

export function loadMergeBackConfig(cwd: string): MergeBackConfig {
  // Shared guarded reader (src/domain/project-settings.ts — no per-module copy).
  const mergeBack = readIterativeGoalSettings(cwd).mergeBack;
  const config = mergeBack && typeof mergeBack === "object" ? mergeBack as Record<string, unknown> : {};
  const testTimeout = typeof config.testTimeoutMs === "number" && Number.isFinite(config.testTimeoutMs)
    ? Math.max(1_000, Math.min(config.testTimeoutMs, 1_800_000))
    : DEFAULT_MERGE_TEST_TIMEOUT_MS;
  let integrationBranch: string | null = null;
  if (typeof config.integrationBranch === "string" && config.integrationBranch.trim().length > 0) {
    const override = config.integrationBranch.trim();
    if (override.startsWith(INTEGRATION_BRANCH_PREFIX)) {
      integrationBranch = override;
    } else {
      // C4-ADV-009: an unconstrained override could name an existing user
      // branch (main) and receive verified shard commits — refuse loudly.
      log(`mergeBack.integrationBranch override "${override}" refused: it must start with ${INTEGRATION_BRANCH_PREFIX} (harness confinement); using the derived per-run branch`);
    }
  }
  return {
    enabled: config.enabled === true,
    promoteToSource: config.promoteToSource === true,
    integrationBranch,
    testCommand: typeof config.testCommand === "string" && config.testCommand.trim().length > 0
      ? config.testCommand.trim()
      : DEFAULT_MERGE_TEST_COMMAND,
    testTimeoutMs: Math.floor(testTimeout),
  };
}

// ── Shard patch artifacts (C4-OUS-001) ────────────────────────────────

/**
 * Persists a completed shard's captured patch bytes into the run dir and
 * returns the repo-relative artifact path (ledgered on the claim via
 * recordShardFinished). Called by the scheduler at shard completion so a
 * crash before merge-back never strands the work — a warm restart rebuilds
 * merge inputs from ledgered claims + these artifacts.
 */
export function persistShardPatchArtifact(
  stateManager: StateManagerAPI,
  cycle: number,
  shardId: string,
  patch: string,
  cwd: string,
): string | null {
  try {
    const safeId = shardId.replace(/[^A-Za-z0-9._-]/g, "-");
    const absolute = stateManager.getArtifactPath(cycle, "implement", `shard-${safeId}.patch`);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, patch);
    return path.relative(cwd, absolute);
  } catch (err) {
    log(`persistShardPatchArtifact failed for shard ${shardId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Reads a ledgered patch artifact back; null when missing/unreadable (fail-closed at the merge gate). */
export function readShardPatchArtifact(cwd: string, artifactPath: string): string | null {
  try {
    const absolute = path.join(cwd, artifactPath);
    if (!fs.existsSync(absolute)) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

// ── Merge driver (§6.6) ───────────────────────────────────────────────

/**
 * One completed shard's captured output, in whatever order execution finished.
 * patch === null means capture FAILED or the ledgered artifact is missing —
 * the merge layer rejects the shard rather than merge-verifying vanished work
 * (C4-ADV-011); "" means the shard genuinely changed nothing.
 */
export interface ShardMergeInput {
  shardId: string;
  patch: string | null;
  /**
   * Explicit rank override only (C4-OUS-009): the merge order reads the HEFT
   * rank from the ledgered claim; this field exists for callers that must
   * deviate deliberately. Omit in normal operation.
   */
  rank?: number | null;
}

export interface MergeBackDeps {
  stateManager: StateManagerAPI;
  cwd: string;
  /** Injectable for tests; defaults to loadMergeBackConfig(cwd). */
  config?: MergeBackConfig;
  /** Injectable test runner; defaults to execSync(testCommand) in the integration worktree. */
  runTests?: (worktreePath: string, command: string, timeoutMs: number) => { ok: boolean; output: string };
  /**
   * Gate part 3 evidence snapshot (wired from src/evaluator.ts →
   * findUnfinishedWork by the caller). Called with the shard being verified
   * so the snapshot EXCLUDES it — the recorded evidence is the post-verdict
   * view and the ledger shows the gate clearing (C4-OUS-006).
   */
  snapshotUnfinishedWork?: (excludeShardId?: string) => { pendingTaskItems: number; unverifiedShards: number };
  now?: () => string;
  log?: (message: string) => void;
}

export interface ShardMergeRejection {
  shardId: string;
  /** Which gate rejected: capture (patch unavailable), allowlist (part 1), apply (patch conflict), tests (part 2). */
  gate: "capture" | "allowlist" | "apply" | "tests";
  reason: string;
}

export interface MergeBackReport {
  enabled: boolean;
  planId: string | null;
  integrationBranch: string | null;
  /** Base ref the integration branch was cut from (null when the branch pre-existed). */
  baseSha: string | null;
  /** Source worktree HEAD captured before merge-back began; the promotion compare-and-swap expectation. */
  sourceHeadBefore: string | null;
  /** Attached source branch ref pinned with sourceHeadBefore; null for detached HEAD. */
  sourceRef: string | null;
  /** Resolved integration branch tip after the shard gate, whether or not delivery was requested. */
  integrationHead: string | null;
  /** Source HEAD after a successful exact fast-forward; null when not delivered. */
  deliveredSha: string | null;
  /** Explicit source-delivery outcome. Promotion is independently default-off. */
  promotionStatus: "disabled" | "blocked" | "promoted";
  /** Human-readable source-delivery decision or failure evidence. */
  promotionReason: string;
  /** Shard ids in HEFT merge order (claim-ledgered rank descending; unranked last, ties by posted index). */
  mergeOrder: string[];
  verified: string[];
  rejected: ShardMergeRejection[];
  /** Shards not proposed (not completed, already verified, unknown) with the reason. */
  skipped: Array<{ shardId: string; reason: string }>;
  commits: Array<{ shardId: string; sha: string }>;
  /** Gate-rejected shards returned to claimed with failure evidence attached (Figure D5 repair loop). */
  repaired: string[];
  reason: string;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveCommit(repoRoot: string, ref: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

function trackedWorktreeStatus(repoRoot: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

const NPM_FAMILY_COMMAND = /^\s*(npm|npx|yarn|pnpm)\b/;

function defaultRunTests(worktreePath: string, command: string, timeoutMs: number): { ok: boolean; output: string } {
  // C4-ADV-006: gate part 2 runs in a FRESH worktree. An npm-family command
  // against declared-but-uninstalled dependencies fails with a clear
  // bootstrap-required message instead of a raw npm error.
  if (NPM_FAMILY_COMMAND.test(command)) {
    try {
      const pkgPath = path.join(worktreePath, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        const declared = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
        if (declared > 0 && !fs.existsSync(path.join(worktreePath, "node_modules"))) {
          return {
            ok: false,
            output: `bootstrap-required: '${command}' needs ${declared} declared dependenc(y/ies), but the fresh integration worktree has no node_modules. Configure iterativeGoal.mergeBack.testCommand to bootstrap (e.g. "npm ci && npm test") or vendor dependencies (C4-ADV-006).`,
          };
        }
      }
    } catch {
      // A package.json we cannot parse is the test runner's own problem — run it.
    }
  }
  try {
    const output = execSync(command, { cwd: worktreePath, encoding: "utf8", timeout: timeoutMs });
    return { ok: true, output };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n") };
  }
}

/** The worktree path currently tracking `branch`, or null (porcelain scan). */
function findWorktreeForBranch(repoRoot: string, branch: string): string | null {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
    for (const block of out.split(/\r?\n\r?\n/)) {
      if (!block.split(/\r?\n/).includes(`branch refs/heads/${branch}`)) continue;
      const line = block.split(/\r?\n/).find((entry) => entry.startsWith("worktree "));
      if (line) return line.slice("worktree ".length);
    }
  } catch { /* treat as absent */ }
  return null;
}

/**
 * Branch confinement (C4-ADV-009): an existing integration branch must be
 * harness-authored (its tip commit carries the merge identity). Anything
 * else — e.g. an override naming a pre-existing user branch — refuses.
 */
function assertHarnessOwnedBranch(repoRoot: string, branch: string): void {
  let author = "";
  try {
    author = execFileSync("git", ["log", "-1", "--format=%ae", branch], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return; // Branch does not exist yet — it will be created below.
  }
  if (author !== MERGE_COMMIT_AUTHOR.email) {
    throw new Error(`integration branch ${branch} exists but its tip commit is not harness-authored (${author || "unknown"}) — refusing to merge onto a non-harness branch (C4-ADV-009)`);
  }
}

function attachedSourceRef(repoRoot: string): string | null {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    return /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

function singleCommitParent(repoRoot: string, commitSha: string): string | null {
  try {
    const parts = execFileSync("git", ["rev-list", "--parents", "-n", "1", commitSha], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim().split(/\s+/);
    return parts.length === 2 ? parts[1] : null;
  } catch {
    return null;
  }
}

/** Prove that applying `patch` to `parentSha` produces exactly commitSha's tree. */
function patchBuildsCommitTree(repoRoot: string, parentSha: string, commitSha: string, patch: string): boolean {
  const tempIndex = path.join(os.tmpdir(), `pi-ig-promotion-index-${crypto.randomBytes(8).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    execFileSync("git", ["read-tree", parentSha], { cwd: repoRoot, env, stdio: "ignore", timeout: 30_000 });
    execFileSync("git", ["apply", "--cached", "--whitespace=nowarn", "-"], {
      cwd: repoRoot,
      env,
      input: patch.endsWith("\n") ? patch : `${patch}\n`,
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 30_000,
      maxBuffer: 100 * 1024 * 1024,
    });
    const reconstructedTree = execFileSync("git", ["write-tree"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    const committedTree = execFileSync("git", ["rev-parse", `${commitSha}^{tree}`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    return reconstructedTree === committedTree;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tempIndex); } catch {}
    try { fs.unlinkSync(`${tempIndex}.lock`); } catch {}
  }
}

function verifyPromotionCommitChain(params: {
  repoRoot: string;
  branch: string;
  baseSha: string;
  integrationHead: string;
  plan: ShardPlan;
  merges: ShardMergeRecord[];
  inputs: ShardMergeInput[];
}): { ok: true; head: string } | { ok: false; reason: string } {
  const mergeByShard = new Map(params.merges
    .filter((merge) => merge.planId === params.plan.id && merge.cycle === params.plan.cycle)
    .map((merge) => [merge.shardId, merge]));
  const inputByShard = new Map(params.inputs.map((input) => [input.shardId, input.patch]));
  const postedIndex = new Map(params.plan.shards.map((shard) => [shard.id, shard.index]));
  const orderedMerges = params.plan.shards.map((shard) => mergeByShard.get(shard.id) ?? null).sort((a, b) => {
    const rankA = a?.rank ?? Number.NEGATIVE_INFINITY;
    const rankB = b?.rank ?? Number.NEGATIVE_INFINITY;
    if (rankA !== rankB) return rankB - rankA;
    return (postedIndex.get(a?.shardId ?? "") ?? 0) - (postedIndex.get(b?.shardId ?? "") ?? 0);
  });
  let cursor = params.baseSha;
  for (const merge of orderedMerges) {
    if (!merge || merge.status !== "verified") {
      return { ok: false, reason: "verified merge chain is missing a planned shard" };
    }
    if (merge.runId !== params.plan.runId || merge.integrationBranch !== params.branch) {
      return { ok: false, reason: `verified merge ${merge.shardId} is bound to a different run or integration branch` };
    }
    const commitSha = merge.integrationCommitSha;
    if (!commitSha || resolveCommit(params.repoRoot, commitSha) !== commitSha) {
      return { ok: false, reason: `verified merge ${merge.shardId} has no resolvable immutable integration commit SHA` };
    }
    let patch = inputByShard.get(merge.shardId);
    if (typeof patch !== "string" && merge.patchArtifactPath) {
      patch = readShardPatchArtifact(params.repoRoot, merge.patchArtifactPath);
    }
    if (typeof patch !== "string") {
      if (merge.patchSha256 === sha256Text("")) patch = "";
      else return { ok: false, reason: `verified merge ${merge.shardId} has no patch bytes for provenance proof` };
    }
    patch = patch.trim();
    if (sha256Text(patch) !== merge.patchSha256) {
      return { ok: false, reason: `verified merge ${merge.shardId} patch hash no longer matches its ledger record` };
    }
    if (patch.length === 0) {
      if (commitSha !== cursor) {
        return { ok: false, reason: `empty verified merge ${merge.shardId} does not bind to its verified predecessor` };
      }
      continue;
    }
    const parentSha = singleCommitParent(params.repoRoot, commitSha);
    if (parentSha !== cursor) {
      return { ok: false, reason: `verified merge ${merge.shardId} is not the next commit in the ordered integration chain` };
    }
    if (!patchBuildsCommitTree(params.repoRoot, cursor, commitSha, patch)) {
      return { ok: false, reason: `verified merge ${merge.shardId} commit tree is not exactly its ledgered patch` };
    }
    cursor = commitSha;
  }
  if (cursor !== params.integrationHead) {
    return { ok: false, reason: `integration tip ${params.integrationHead} is not the exact end of the verified commit chain ${cursor}` };
  }
  return { ok: true, head: cursor };
}

function advanceAttachedSourceRef(params: {
  repoRoot: string;
  sourceRef: string;
  expectedOldSha: string;
  verifiedNewSha: string;
}): void {
  execFileSync("git", [
    "update-ref", "-m", "pi-iterative-goal verified shard promotion",
    params.sourceRef, params.verifiedNewSha, params.expectedOldSha,
  ], { cwd: params.repoRoot, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  try {
    if (resolveCommit(params.repoRoot, params.sourceRef) !== params.verifiedNewSha) {
      throw new Error("source ref moved again immediately after compare-and-swap");
    }
    // update-ref intentionally moves only the exact ref. Refresh this clean
    // attached worktree without `--hard`: --merge refuses to overwrite a
    // concurrent tracked edit that appeared after the cleanliness check.
    execFileSync("git", ["reset", "--merge", params.verifiedNewSha], {
      cwd: params.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    // Roll the ref back only if it is still exactly the SHA this invocation
    // installed. A concurrent third-party advance is never overwritten.
    try {
      execFileSync("git", ["update-ref", params.sourceRef, params.expectedOldSha, params.verifiedNewSha], {
        cwd: params.repoRoot,
        stdio: "ignore",
        timeout: 30_000,
      });
      execFileSync("git", ["reset", "--merge", params.expectedOldSha], {
        cwd: params.repoRoot,
        stdio: "ignore",
        timeout: 30_000,
      });
    } catch { /* leave exact failure evidence to the caller; never force-reset */ }
    throw error;
  }
}

/**
 * Applies a shard plan's captured patches onto the integration branch in HEFT
 * order, gating each through merge_proposed → (gates) → merge_verified, and
 * returning gate-rejected shards to claimed with failure evidence attached.
 * Flag-gated: with mergeBack disabled it returns before touching the ledger,
 * git, or the filesystem beyond config reads (§8.7 rollback).
 *
 * Idempotent: shards already merge_verified are skipped, so a re-driven
 * transition never re-applies or re-commits verified work.
 */
export async function mergeShardPlan(
  plan: ShardPlan,
  inputs: ShardMergeInput[],
  deps: MergeBackDeps,
): Promise<MergeBackReport> {
  const config = deps.config ?? loadMergeBackConfig(deps.cwd);
  const now = deps.now ?? (() => new Date().toISOString());
  const runTests = deps.runTests ?? defaultRunTests;
  const empty: MergeBackReport = {
    enabled: config.enabled,
    planId: plan.id,
    integrationBranch: null,
    baseSha: null,
    sourceHeadBefore: null,
    sourceRef: null,
    integrationHead: null,
    deliveredSha: null,
    promotionStatus: config.promoteToSource ? "blocked" : "disabled",
    promotionReason: config.promoteToSource
      ? "source promotion blocked: merge-back is disabled"
      : "source promotion is disabled (default off)",
    mergeOrder: [],
    verified: [],
    rejected: [],
    skipped: [],
    commits: [],
    repaired: [],
    reason: "",
  };
  if (!config.enabled) {
    return {
      ...empty,
      reason: "merge-back disabled by flag — patches surface as [ISOLATED_WORKTREE_PATCH] blocks for manual application (§8.7 rollback)",
    };
  }
  const state = deps.stateManager.getState();
  if (!state) throw new Error("mergeShardPlan requires an active run");
  const runId = state.runId;
  const branch = config.integrationBranch ?? `pi-ig/integration/${runId.replace(/[^A-Za-z0-9._/-]/g, "-")}`;
  // This immutable source expectation is checked again immediately before
  // promotion. A concurrent source advance must never be silently included
  // in, reset by, or overwritten with the integration result.
  const sourceHeadAtStart = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: deps.cwd,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  const sourceRefAtStart = attachedSourceRef(deps.cwd);

  const shardIndex = new Map(plan.shards.map((shard) => [shard.id, shard.index]));
  const claimsByShardId = new Map(
    state.shards.claims
      .filter((claim) => claim.planId === plan.id && claim.cycle === plan.cycle)
      .map((claim) => [claim.shardId, claim]),
  );
  // HEFT merge order (§6.6): the ledgered claim rank is the source of truth
  // (C4-OUS-009); ShardMergeInput.rank is an explicit override only. Unranked
  // shards sort last; ties keep posted (partition index) order.
  const effectiveRank = (input: ShardMergeInput): number | null =>
    input.rank ?? claimsByShardId.get(input.shardId)?.rank ?? null;
  const ordered = [...inputs].sort((a, b) => {
    const rankA = effectiveRank(a) ?? Number.NEGATIVE_INFINITY;
    const rankB = effectiveRank(b) ?? Number.NEGATIVE_INFINITY;
    if (rankA !== rankB) return rankB - rankA;
    return (shardIndex.get(a.shardId) ?? 0) - (shardIndex.get(b.shardId) ?? 0);
  });
  const report: MergeBackReport = {
    ...empty,
    integrationBranch: branch,
    sourceHeadBefore: sourceHeadAtStart,
    sourceRef: sourceRefAtStart,
    promotionStatus: config.promoteToSource ? "blocked" : "disabled",
    promotionReason: config.promoteToSource
      ? "source promotion has not passed its delivery gates"
      : "source promotion is disabled (default off)",
    mergeOrder: ordered.map((input) => input.shardId),
  };

  let worktreePath: string | null = null;
  let integrationLease: IntegrationLease | null = null;
  let integrationLeaseAdopted = false;
  try {
    // Lazily create the integration branch + worktree on the first shard that
    // is actually proposed — a fully-skipped batch leaves no git trace.
    let branchReady = false;
    const ensureWorktree = (): string => {
      if (worktreePath) return worktreePath;
      integrationLease ??= acquireIntegrationLease(deps.cwd, branch);
      if (!branchReady) {
        const baseSha = sourceHeadAtStart;
        try {
          execFileSync("git", ["rev-parse", "--verify", branch], { cwd: deps.cwd, stdio: "ignore" });
          assertHarnessOwnedBranch(deps.cwd, branch);
        } catch (err) {
          if (err instanceof Error && err.message.includes("refusing to merge onto a non-harness branch")) throw err;
          execFileSync("git", ["branch", branch, baseSha], { cwd: deps.cwd, stdio: "ignore" });
          report.baseSha = baseSha;
        }
        branchReady = true;
      }
      // A prior crash may leave the branch checked out. Never reset or reuse a
      // surviving worktree: only an exact v2 marker whose recorded process is
      // provably dead may be removed while this invocation holds the atomic
      // branch lease. Live or ambiguous ownership fails closed.
      const existing = findWorktreeForBranch(deps.cwd, branch);
      if (existing && fs.existsSync(existing)) {
        const marker = readWorktreeMarker(existing);
        const status = marker ? ownerStatus(marker) : "ambiguous";
        const reclaimable = marker?.schema === WORKTREE_MARKER_SCHEMA
          && marker.kind === "integration"
          && marker.branch === branch
          && typeof marker.leaseNonce === "string"
          && marker.leaseNonce === integrationLease.predecessor?.nonce
          && status === "dead";
        if (!reclaimable) {
          throw new Error(`integration worktree ${existing} has ${status} or unverifiable ownership; refusing reset/reuse`);
        }
        removeWorktree(deps.cwd, existing);
        integrationLeaseAdopted = true;
      } else if (existing) {
        execFileSync("git", ["worktree", "remove", "--force", existing], {
          cwd: deps.cwd,
          stdio: "ignore",
          timeout: 30_000,
        });
        integrationLeaseAdopted = true;
      }
      const safeRun = runId.replace(/[^A-Za-z0-9._-]/g, "-");
      worktreePath = path.join(os.tmpdir(), `pi-ig-integration-${safeRun}-${crypto.randomBytes(4).toString("hex")}`);
      // Branch-tracked (not --detach): verified commits advance the branch ref.
      execFileSync("git", ["worktree", "add", worktreePath, branch], { cwd: deps.cwd, stdio: "ignore" });
      registerWorktreeForCleanup(deps.cwd, worktreePath);
      writeWorktreeMarker(worktreePath, "integration", integrationLease, true);
      integrationLeaseAdopted = true;
      return worktreePath;
    };

    for (const input of ordered) {
      const shard = plan.shards.find((item) => item.id === input.shardId);
      if (!shard) {
        report.skipped.push({ shardId: input.shardId, reason: "shard not in plan" });
        continue;
      }
      const key = { planId: plan.id, cycle: plan.cycle, shardId: input.shardId };
      const priorMerge = state.shards.merges.find(
        (item) => item.planId === key.planId && item.cycle === key.cycle && item.shardId === key.shardId,
      );
      if (priorMerge?.status === "verified") {
        report.skipped.push({ shardId: input.shardId, reason: "already merge_verified" });
        continue;
      }
      const claim = claimsByShardId.get(input.shardId);
      if (claim?.status !== "completed") {
        report.skipped.push({ shardId: input.shardId, reason: `claim status is ${claim?.status ?? "missing"}, not completed` });
        continue;
      }

      // Gate rejection (Figure D5): merge_proposed → failed → claimed, with
      // the failure evidence attached to the repair re-claim. The integration
      // worktree is restored to the last verified state first, so siblings
      // merge onto verified work only.
      const reject = (gate: ShardMergeRejection["gate"], reason: string): void => {
        if (worktreePath) {
          try {
            execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: worktreePath, stdio: "ignore" });
            execFileSync("git", ["clean", "-fd"], { cwd: worktreePath, stdio: "ignore" });
            writeWorktreeMarker(worktreePath, "integration", integrationLease ?? undefined, true);
          } catch (err) {
            log(`integration worktree restore after ${gate} rejection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        deps.stateManager.recordShardFinished(input.shardId, {
          runId, planId: plan.id, cycle: plan.cycle, status: "failed", error: reason,
        });
        deps.stateManager.recordShardClaimed({
          shardId: input.shardId,
          planId: plan.id,
          runId,
          cycle: plan.cycle,
          status: "claimed",
          workerSlot: claim.workerSlot,
          rank: claim.rank,
          // Repair pending re-dispatch: no dispatch task exists yet, and the
          // null taskId keeps restore-time crash reconciliation (C3-ADV-009)
          // from failing this claim for a task that never ran.
          taskId: null,
          claimedAt: now(),
          finishedAt: null,
          error: reason,
          patchArtifactPath: claim.patchArtifactPath,
        }, {
          repairLoop: true,
          rejectedFrom: "merge_gate",
          gateFailure: { gate, reason, patchSha256: claim.patchArtifactPath ? sha256Text(input.patch ?? "") : null },
        });
        report.rejected.push({ shardId: input.shardId, gate, reason });
        report.repaired.push(input.shardId);
        deps.log?.(`merge gate REJECTED shard ${input.shardId} (${gate}): ${reason} — returned to claimed for repair (Figure D5)`);
      };

      // C4-ADV-011: an unavailable patch (capture failure / missing ledgered
      // artifact) is a rejection, never a merge_verified with vanished work.
      if (input.patch === null) {
        reject("capture", "patch unavailable (capture failed or ledgered artifact missing) — refusing to merge-verify vanished work");
        continue;
      }
      const patch = input.patch.trim();
      const patchSha256 = sha256Text(patch);
      const proposedAt = now();
      const mergeRecord: ShardMergeRecord = {
        shardId: input.shardId,
        planId: plan.id,
        runId,
        cycle: plan.cycle,
        status: "proposed",
        patchSha256,
        patchArtifactPath: claim.patchArtifactPath,
        integrationBranch: branch,
        integrationCommitSha: null,
        rank: effectiveRank(input),
        gate: null,
        error: null,
        proposedAt,
        verifiedAt: null,
      };
      deps.stateManager.recordMergeProposed(mergeRecord);

      // Gate part 1 (§6.6): the captured diff against the shard's own
      // path-scope allowlist, before any application is attempted. Git-native
      // and fail-closed (C4-ADV-001/C4-ADV-002) — unparseable sections and
      // un-normalizable paths are violations, never throws.
      const scopeCheck = verifyShardPatchAgainstScope(patch, shard.allowedPaths, { cwd: deps.cwd });
      if (scopeCheck.allowlistViolation) {
        const detail = [
          scopeCheck.extraFiles.length > 0 ? `files outside the shard write scope: ${scopeCheck.extraFiles.join(", ")}` : "",
          scopeCheck.parseErrors.length > 0 ? `unparseable patch sections (fail-closed): ${scopeCheck.parseErrors.join(" | ")}` : "",
        ].filter(Boolean).join("; ");
        reject("allowlist", `patch rejected by the shard scope gate — ${detail}`);
        continue;
      }

      const tree = ensureWorktree();
      if (patch.length > 0) {
        // Conflict surface (§6.6): isolation deferred conflicts to merge
        // time; a patch that no longer applies onto the merged tree (e.g.
        // two shard diffs touching the same bridge file) is rejected here.
        // 2-way only, deliberately — a stale base means HEAD moved mid-run,
        // which should reject rather than silently 3-way merge (C4-ADV-013).
        // The ledger hash rides the trimmed capture, but git apply requires
        // the trailing newline the capture's .trim() removed.
        const applyPayload = patch.endsWith("\n") ? patch : `${patch}\n`;
        try {
          execFileSync("git", ["apply", "--check", "-"], { cwd: tree, input: applyPayload, stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
          reject("apply", `patch does not apply onto the integration branch (merge-time conflict): ${stderr || (err instanceof Error ? err.message : String(err))}`);
          continue;
        }
        execFileSync("git", ["apply", "-"], { cwd: tree, input: applyPayload, stdio: ["pipe", "ignore", "pipe"] });
      }

      // Gate part 2 (§6.6): the repository test suite on the MERGED tree.
      const tests = runTests(tree, config.testCommand, config.testTimeoutMs);
      if (!tests.ok) {
        reject("tests", `repository test suite failed on the merged tree (${config.testCommand}): ${tests.output.slice(-800)}`);
        continue;
      }

      // Gate part 3 evidence snapshot, POST-verdict view: the shard being
      // verified is excluded so the ledger shows the gate clearing
      // (C4-OUS-006). Goal-time enforcement stays with the evaluator.
      const unfinished = deps.snapshotUnfinishedWork?.(input.shardId) ?? null;

      // Land the verified patch: one commit per shard on the integration
      // branch, staging ONLY the patch's own file list (C4-ADV-005 — test
      // side effects like coverage/ never enter the shard commit whose
      // message carries the patch provenance hash).
      let sha = "";
      if (patch.length > 0 && scopeCheck.changedFiles.length > 0) {
        execFileSync("git", ["add", "-A", "--", ...scopeCheck.changedFiles], { cwd: tree, stdio: "ignore" });
        const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: tree, encoding: "utf8" }).trim();
        if (staged) {
          execFileSync("git", [
            "-c", `user.name=${MERGE_COMMIT_AUTHOR.name}`,
            "-c", `user.email=${MERGE_COMMIT_AUTHOR.email}`,
            "commit", "-q", "-m",
            `merge(${input.shardId}): plan ${plan.id} cycle ${plan.cycle}\n\nmerge_verified gate evidence\npatchSha256=${patchSha256}`,
          ], { cwd: tree, stdio: "ignore" });
          sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).trim();
        }
      }

      const verifiedIntegrationCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tree,
        encoding: "utf8",
        timeout: 30_000,
      }).trim();

      deps.stateManager.recordMergeVerified(input.shardId, {
        runId,
        planId: plan.id,
        cycle: plan.cycle,
        integrationCommitSha: verifiedIntegrationCommitSha,
        gate: {
          allowlistOk: true,
          extraFiles: [],
          testsOk: true,
          testCommand: config.testCommand,
          unfinishedWork: unfinished,
        },
        verifiedAt: now(),
      });
      report.verified.push(input.shardId);
      if (sha) report.commits.push({ shardId: input.shardId, sha });
      deps.log?.(`merge_verified shard ${input.shardId} onto ${branch}${sha ? ` (${sha.slice(0, 12)})` : " (no changes)"}`);
    }
  } finally {
    if (worktreePath) removeWorktree(deps.cwd, worktreePath);
    if (integrationLease) releaseIntegrationLease(integrationLease, !integrationLeaseAdopted);
  }

  report.integrationHead = resolveCommit(deps.cwd, branch);
  if (config.promoteToSource) {
    const latestState = deps.stateManager.getState();
    const unverifiedShards = plan.shards.filter((shard) => {
      const merge = latestState?.shards.merges.find(
        (item) => item.planId === plan.id && item.cycle === plan.cycle && item.shardId === shard.id,
      );
      return merge?.status !== "verified";
    }).map((shard) => shard.id);
    const unsafeSkips = report.skipped.filter((item) => item.reason !== "already merge_verified");

    const verifiedChain = report.integrationHead && latestState
      ? verifyPromotionCommitChain({
          repoRoot: deps.cwd,
          branch,
          baseSha: sourceHeadAtStart,
          integrationHead: report.integrationHead,
          plan,
          merges: latestState.shards.merges,
          inputs,
        })
      : null;

    if (report.rejected.length > 0) {
      report.promotionReason = `source promotion blocked: ${report.rejected.length} shard merge gate rejection(s)`;
    } else if (unsafeSkips.length > 0) {
      report.promotionReason = `source promotion blocked: ${unsafeSkips.length} shard input(s) skipped without an existing merge_verified verdict`;
    } else if (unverifiedShards.length > 0) {
      report.promotionReason = `source promotion blocked: not every planned shard is merge_verified (${unverifiedShards.join(", ")})`;
    } else if (!report.integrationHead) {
      report.promotionReason = `source promotion blocked: integration branch ${branch} has no resolvable commit`;
    } else if (!sourceRefAtStart) {
      report.promotionReason = "source promotion blocked: source HEAD was detached; an attached branch ref must be pinned at merge start";
    } else if (attachedSourceRef(deps.cwd) !== sourceRefAtStart) {
      report.promotionReason = `source promotion blocked: attached source ref changed from ${sourceRefAtStart} to ${attachedSourceRef(deps.cwd) ?? "detached"}`;
    } else if (!verifiedChain?.ok) {
      report.promotionReason = `source promotion blocked: ${verifiedChain?.reason ?? "verified commit-chain proof unavailable"}`;
    } else {
      const sourceHeadNow = resolveCommit(deps.cwd, "HEAD");
      const sourceRefHeadNow = resolveCommit(deps.cwd, sourceRefAtStart);
      if (sourceHeadNow !== sourceHeadAtStart || sourceRefHeadNow !== sourceHeadAtStart) {
        report.promotionReason = `source promotion blocked: source HEAD moved from ${sourceHeadAtStart} to ${sourceHeadNow ?? "unresolvable"}`;
      } else {
        let trackedStatus = "";
        let cleanlinessChecked = false;
        try {
          trackedStatus = trackedWorktreeStatus(deps.cwd);
          cleanlinessChecked = true;
        } catch (err) {
          report.promotionReason = `source promotion blocked: tracked worktree cleanliness check failed (${err instanceof Error ? err.message : String(err)})`;
        }
        if (cleanlinessChecked) {
          if (trackedStatus.length > 0) {
            report.promotionReason = "source promotion blocked: source worktree has tracked changes";
          } else {
            try {
              // Re-apply ownership on a warm resume, then freeze every mutable
              // input immediately before the exact-ref CAS. The branch name is
              // never passed to the delivery command.
              if (verifiedChain.head !== sourceHeadAtStart) {
                assertHarnessOwnedBranch(deps.cwd, branch);
              }
              if (resolveCommit(deps.cwd, branch) !== verifiedChain.head) {
                throw new Error(`integration branch moved after proof; expected ${verifiedChain.head}`);
              }
              if (attachedSourceRef(deps.cwd) !== sourceRefAtStart
                || resolveCommit(deps.cwd, sourceRefAtStart) !== sourceHeadAtStart
                || resolveCommit(deps.cwd, "HEAD") !== sourceHeadAtStart
                || trackedWorktreeStatus(deps.cwd).length > 0) {
                throw new Error("source ref, HEAD, or tracked worktree changed after promotion preflight");
              }
              advanceAttachedSourceRef({
                repoRoot: deps.cwd,
                sourceRef: sourceRefAtStart,
                expectedOldSha: sourceHeadAtStart,
                verifiedNewSha: verifiedChain.head,
              });
              const deliveredSha = resolveCommit(deps.cwd, "HEAD");
              const deliveredRefSha = resolveCommit(deps.cwd, sourceRefAtStart);
              if (!deliveredSha || deliveredSha !== verifiedChain.head || deliveredRefSha !== verifiedChain.head) {
                report.promotionReason = `source promotion blocked: post-CAS source ref/HEAD does not equal verified tip ${verifiedChain.head}`;
              } else {
                report.deliveredSha = deliveredSha;
                report.promotionStatus = "promoted";
                report.promotionReason = `source ref ${sourceRefAtStart} compare-and-swapped exactly to verified commit ${verifiedChain.head}`;
              }
            } catch (err) {
              const failure = err as { stderr?: Buffer | string; message?: string };
              const stderr = typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString();
              report.promotionReason = `source promotion blocked: exact-ref compare-and-swap failed (${(stderr || failure.message || String(err)).trim().slice(-800)})`;
            }
          }
        }
      }
    }
  }

  report.reason = `merge-back over ${report.mergeOrder.length} shard patch(es) in HEFT order: ${report.verified.length} verified, ${report.rejected.length} rejected, ${report.skipped.length} skipped`;
  return report;
}

// ── Lifecycle seam (§6.6) ─────────────────────────────────────────────

/** Minimal scheduler-report shape the merge hook consumes (C3 ShardExecutionReport). */
export interface MergeBackHookSchedulerReport {
  outcomes: Array<{ task: { id: string }; ok: boolean; result: { patch?: string | null } | null }>;
}

export interface MergeBackHookDeps {
  stateManager: StateManagerAPI;
  cwd: string;
  /**
   * The scheduler report from the same plan→implement transition. Absent
   * (warm restart — the scheduler's idempotency skip produces no report),
   * the hook rebuilds its inputs from ledgered claims + patch artifacts
   * (C4-OUS-001) instead of starving.
   */
  schedulerReport?: MergeBackHookSchedulerReport | null;
  /** Gate part 3 evidence snapshot (lifecycle wires src/evaluator.ts → findUnfinishedWork). */
  snapshotUnfinishedWork?: (excludeShardId?: string) => { pendingTaskItems: number; unverifiedShards: number };
  /** Injectable for tests; defaults to loadMergeBackConfig(cwd).enabled. */
  mergeBackEnabled?: boolean;
  log?: (message: string) => void;
}

/**
 * The merge-back hook at the plan→implement transition, called from
 * advanceToNextPhase immediately after runSchedulerHook — the scheduler
 * executes the fan_out plan synchronously, and the completed shards' captured
 * patches merge onto the integration branch in HEFT order. Flag-gated:
 * with mergeBack disabled it returns before touching anything, so flag-off
 * behavior is byte-identical to pre-C4 (§8.7 rollback). Exceptions propagate
 * to the lifecycle call site's try/catch, which degrades to the single-slice
 * implement prompt.
 */
export async function runMergeBackHook(deps: MergeBackHookDeps): Promise<MergeBackReport | null> {
  const enabled = deps.mergeBackEnabled ?? loadMergeBackConfig(deps.cwd).enabled;
  if (!enabled) return null;

  const state = deps.stateManager.getState();
  if (!state || state.status !== "running") return null;
  const plan = [...state.shards.plans].reverse().find(
    (candidate) => candidate.cycle === state.cycle && candidate.decision === "fan_out" && candidate.shards.length > 0,
  );
  if (!plan) return null;

  // Same-transition hand-off: match outcomes to shards via the scheduler's
  // OWN task-id helper (C4-OUS-008 — no duplicated string convention).
  const outcomes = deps.schedulerReport?.outcomes ?? [];
  const inputs: ShardMergeInput[] = [];
  let matched = 0;
  for (const shard of plan.shards) {
    const outcome = outcomes.find((candidate) => candidate.task.id === shardDispatchTaskId(plan.cycle, shard.id));
    if (!outcome) continue;
    matched += 1;
    // result.patch undefined/null = capture failure → null → capture-gate
    // rejection downstream (C4-ADV-011), never a silent merge.
    inputs.push({ shardId: shard.id, patch: outcome.result?.patch ?? null });
  }
  if (matched === 0) {
    if (deps.schedulerReport) {
      deps.log?.("merge-back hook: scheduler report carried no shard outcomes for this plan — falling back to ledgered claims + patch artifacts");
    }
    // Warm-restart rebuild (C4-OUS-001): the scheduler's idempotency skip
    // starves the in-memory hand-off, so inputs come from the ledger —
    // completed claims plus their persisted patch artifacts.
    for (const shard of plan.shards) {
      const claim = state.shards.claims.find(
        (item) => item.planId === plan.id && item.cycle === plan.cycle && item.shardId === shard.id,
      );
      if (claim?.status !== "completed") continue;
      inputs.push({
        shardId: shard.id,
        patch: claim.patchArtifactPath ? readShardPatchArtifact(deps.cwd, claim.patchArtifactPath) : null,
      });
    }
  }
  if (inputs.length === 0) {
    deps.log?.("merge-back hook: no completed shard patches to merge (enabled hook found zero matching outcomes, C4-OUS-008)");
    return null;
  }

  return await mergeShardPlan(plan, inputs, {
    stateManager: deps.stateManager,
    cwd: deps.cwd,
    snapshotUnfinishedWork: deps.snapshotUnfinishedWork,
    log: deps.log,
  });
}
