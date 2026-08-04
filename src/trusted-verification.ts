import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { attestAction, verifyActionAttestation } from "./cyber-runtime.js";
import type { CommandSpec, VerificationResult, VerificationSpec } from "./domain/verification.js";
import type { StateManagerAPI } from "./state.js";
import {
  materializeTrustedNpmCache,
  trustedNpmMaterializationMatchesLock,
  type TrustedNpmMaterializationReceipt,
} from "./trusted-dependencies.js";
import type { IterativeGoalState } from "./types.js";

export const TRUSTED_VERIFICATION_SCHEMA = "pi-iterative-goal.trusted-verification.v6" as const;
export const TRUSTED_VERIFICATION_CONFIG_SCHEMA = "pi-iterative-goal.trusted-verification-config.v1" as const;
export const TRUSTED_VERIFICATION_CONFIG_PATH = "config/trusted-verification.json" as const;
const MAX_TRUSTED_VERIFICATION_CONFIG_BYTES = 128 * 1024;
const MAX_TRUSTED_VERIFICATION_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_TRUSTED_VERIFICATION_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_TRUSTED_PROCESS_SUPERVISOR_BYTES = 128 * 1024;
const MAX_TRUSTED_RUNTIME_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
export const TRUSTED_PROCESS_SUPERVISOR_SHA256 = "8412d0b564238ea779a33ce308a6542f627b38f562e2634d2a0fd152cefe0f3e" as const;
export const TRUSTED_PROCESS_SUPERVISOR_PATH = "scripts/trusted-process-supervisor.mjs" as const;

export interface TrustedRuntimeExecutableIdentity {
  path: string;
  sha256: string;
  size: number;
}

interface CapturedRuntimeExecutableIdentity extends TrustedRuntimeExecutableIdentity {
  device: number;
  inode: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

function captureRuntimeExecutableIdentity(executablePath: string): CapturedRuntimeExecutableIdentity {
  const absolutePath = path.resolve(executablePath);
  const canonicalPath = fs.realpathSync(absolutePath);
  if (canonicalPath !== absolutePath) throw new Error("trusted runtime executable path must be canonical and symlink-free");
  const descriptor = fs.openSync(canonicalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || (before.mode & 0o111) === 0) {
      throw new Error("trusted runtime executable must be an executable regular file");
    }
    if (before.size <= 0 || before.size > MAX_TRUSTED_RUNTIME_EXECUTABLE_BYTES) {
      throw new Error(`trusted runtime executable exceeds ${MAX_TRUSTED_RUNTIME_EXECUTABLE_BYTES} bytes`);
    }
    const digest = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_TRUSTED_RUNTIME_EXECUTABLE_BYTES) {
        throw new Error(`trusted runtime executable grew beyond ${MAX_TRUSTED_RUNTIME_EXECUTABLE_BYTES} bytes`);
      }
      digest.update(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || total !== before.size) {
      throw new Error("trusted runtime executable changed while it was being authenticated");
    }
    return {
      path: canonicalPath,
      sha256: digest.digest("hex"),
      size: total,
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameRuntimeExecutableIdentity(
  left: CapturedRuntimeExecutableIdentity,
  right: CapturedRuntimeExecutableIdentity,
): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.size === right.size
    && left.device === right.device && left.inode === right.inode && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function publicRuntimeExecutableIdentity(identity: CapturedRuntimeExecutableIdentity): TrustedRuntimeExecutableIdentity {
  return { path: identity.path, sha256: identity.sha256, size: identity.size };
}

function trustedGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

function trustedGitArgs(args: string[]): string[] {
  return ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];
}

export type TrustedVerificationSandboxBackend = "macos-sandbox-exec" | "linux-bwrap";

export interface TrustedVerificationSandboxReceipt {
  backend: TrustedVerificationSandboxBackend;
  profile: "deny-default-v1";
  enforced: true;
  networkDenied: true;
  ambientCredentialsStripped: true;
  validationWorktreeWritable: true;
  sourceRepositoryReadDenied: true;
  descendantProcessContainment: "isolated-process-lifetime-v1";
}

export interface TrustedVerificationProcessContainment {
  /** False only when execution was deliberately skipped before a child existed. */
  isolatedProcessGroup: boolean;
  descendantsTerminated: boolean;
  cleanupSignal: "SIGTERM" | "SIGKILL" | null;
  identityCensus: "macos-sandbox-check-v1" | "linux-pid-namespace-v1";
  identityMatchesObserved: number;
}

export interface TrustedVerificationConfig {
  enabled: boolean;
  checks: VerificationSpec[];
}

export interface TrustedVerificationResult extends VerificationResult {
  startedAt: string;
  endedAt: string;
  artifactSha256: string;
  timedOut: boolean;
  signal: string | null;
  processContainment: TrustedVerificationProcessContainment;
}

export interface TrustedVerificationReceiptV1 {
  schema: typeof TRUSTED_VERIFICATION_SCHEMA;
  runId: string;
  cycle: number;
  sourceSha: string;
  sourceShaAfter: string;
  /** Detached validation checkout HEAD before checks execute. */
  validationSha: string;
  /** Detached validation checkout HEAD after all checks execute. */
  validationShaAfter: string;
  sourceTrackedTreeCleanBefore: boolean;
  sourceTrackedTreeCleanAfter: boolean;
  validationTrackedTreeClean: boolean;
  /** Compatibility summary: all source/validation tracked trees were clean. */
  trackedTreeClean: boolean;
  startedAt: string;
  endedAt: string;
  checksHash: string;
  resultsHash: string;
  /** OS-enforced boundary used for the offline dependency install and every check. */
  sandbox: TrustedVerificationSandboxReceipt;
  /** Authenticated standalone supervisor blob used for every sandbox launch. */
  supervisorHelperSha256: typeof TRUSTED_PROCESS_SUPERVISOR_SHA256;
  /** Exact Node executable used to launch the authenticated supervisor. */
  supervisorRuntimeExecutable: TrustedRuntimeExecutableIdentity;
  /** Metadata-only proof that every private-cache tarball matched the exact lock. */
  dependencyMaterialization: TrustedNpmMaterializationReceipt | null;
  /** Lockfile-derived dependency install executed with lifecycle scripts disabled. */
  dependencyBootstrap: TrustedVerificationResult | null;
  results: TrustedVerificationResult[];
  ok: boolean;
}

function resolveRepositoryRoot(cwd: string): string {
  const start = fs.realpathSync(cwd);
  try {
    const root = execFileSync("git", trustedGitArgs(["rev-parse", "--show-toplevel"]), {
      cwd: start,
      encoding: "utf8",
      timeout: 30_000,
      env: trustedGitEnvironment(),
    }).trim();
    return fs.realpathSync(root);
  } catch {
    // Config loading is also used in non-repository harness contexts. The
    // verifier itself will still fail closed on its first required git query.
    return start;
  }
}

function isCommandSpec(value: unknown): value is CommandSpec {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return typeof command.executable === "string"
    && command.executable.length > 0
    && command.executable.length <= 4096
    && !command.executable.includes("\0")
    && (!path.isAbsolute(command.executable) || path.resolve(command.executable) === path.resolve(process.execPath))
    && Array.isArray(command.argv)
    && command.argv.length <= 256
    && command.argv.every((item) => typeof item === "string" && item.length <= 65_536 && !item.includes("\0"))
    && (command.cwd === undefined || (typeof command.cwd === "string" && !command.cwd.includes("\0") && !path.isAbsolute(command.cwd)))
    && (command.timeoutMs === undefined || (typeof command.timeoutMs === "number"
      && Number.isSafeInteger(command.timeoutMs)
      && command.timeoutMs > 0
      && command.timeoutMs <= 3_600_000));
}

export function loadTrustedVerificationConfig(cwd: string): TrustedVerificationConfig {
  const repositoryRoot = resolveRepositoryRoot(cwd);
  let rawBytes: string;
  try {
    execFileSync("git", trustedGitArgs(["cat-file", "-e", `HEAD:${TRUSTED_VERIFICATION_CONFIG_PATH}`]), {
      cwd: repositoryRoot,
      stdio: "ignore",
      timeout: 30_000,
      env: trustedGitEnvironment(),
    });
  } catch {
    // Trusted checks are optional when the committed policy file is absent.
    // An ignored or untracked .pi/settings.json is deliberately never a
    // verification authority.
    return { enabled: false, checks: [] };
  }
  try {
    rawBytes = execFileSync("git", trustedGitArgs(["show", `HEAD:${TRUSTED_VERIFICATION_CONFIG_PATH}`]), {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_TRUSTED_VERIFICATION_CONFIG_BYTES,
      env: trustedGitEnvironment(),
    });
  } catch (error) {
    throw new Error(`Unable to read committed trusted-verification policy at ${TRUSTED_VERIFICATION_CONFIG_PATH}`, { cause: error });
  }
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBytes) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("policy must be an object");
    config = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Committed trusted-verification policy is invalid JSON: ${TRUSTED_VERIFICATION_CONFIG_PATH}`, { cause: error });
  }
  if (config.schema !== TRUSTED_VERIFICATION_CONFIG_SCHEMA) {
    throw new Error(`Committed trusted-verification policy schema is invalid: ${TRUSTED_VERIFICATION_CONFIG_PATH}`);
  }
  if (config.enabled !== true) return { enabled: false, checks: [] };
  const configured = Array.isArray(config.checks) ? config.checks : [];
  if (configured.length > 64) throw new Error("trustedVerification supports at most 64 checks");
  const checks: VerificationSpec[] = [];
  for (const [index, item] of configured.entries()) {
    if (!item || typeof item !== "object") throw new Error(`trustedVerification.checks[${index}] must be an object`);
    const check = item as Record<string, unknown>;
    if (typeof check.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(check.id)) throw new Error(`trustedVerification.checks[${index}].id is invalid`);
    if (typeof check.name !== "string" || !check.name.trim()) throw new Error(`trustedVerification.checks[${index}].name is invalid`);
    if (!isCommandSpec(check.command)) throw new Error(`trustedVerification.checks[${index}].command must be executable plus argv and a repository-relative cwd`);
    checks.push({ id: check.id, name: check.name, required: check.required !== false, command: check.command });
  }
  if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new Error("trustedVerification check ids must be unique");
  if (checks.length > 0) return { enabled: true, checks };
  return {
    enabled: true,
    checks: [
      { id: "typecheck", name: "TypeScript typecheck", required: true, command: { executable: "npm", argv: ["run", "typecheck"], timeoutMs: 180_000 } },
      { id: "build", name: "Clean detached build", required: true, command: { executable: "npm", argv: ["run", "build"], timeoutMs: 180_000 } },
      { id: "smoke", name: "Deterministic smoke suite", required: true, command: { executable: "npm", argv: ["run", "smoke"], timeoutMs: 600_000 } },
    ],
  };
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function trustedVerificationConfigHash(config: TrustedVerificationConfig): string {
  return sha256(JSON.stringify({ enabled: config.enabled, checks: config.checks }));
}

export function trustedVerificationPolicyMatches(
  pinned: IterativeGoalState["trustedVerification"] | undefined,
  config: TrustedVerificationConfig,
): boolean {
  if (!pinned?.required) return true;
  return config.enabled && pinned.checksHash === trustedVerificationConfigHash(config);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", trustedGitArgs(args), {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: trustedGitEnvironment(),
  }).trim();
}

function trackedTreeClean(cwd: string): boolean {
  let scratch: string | null = null;
  try {
    const tags = git(cwd, ["ls-files", "-v", "--"]);
    if (tags.split(/\r?\n/).filter(Boolean).some((line) => /^[a-zS]/.test(line))) return false;
    execFileSync("git", trustedGitArgs(["diff-index", "--cached", "--quiet", "HEAD", "--"]), {
      cwd,
      stdio: "ignore",
      timeout: 30_000,
      env: trustedGitEnvironment(),
    });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-clean-index-"));
    const indexPath = path.join(scratch, "index");
    const env = trustedGitEnvironment({ GIT_INDEX_FILE: indexPath });
    execFileSync("git", trustedGitArgs(["read-tree", "HEAD"]), {
      cwd,
      stdio: "ignore",
      timeout: 30_000,
      env,
    });
    // read-tree deliberately leaves the fresh index without worktree stat
    // data, so diff-files would otherwise report every tracked path as dirty.
    // Refreshing this independent index both populates that data and forces
    // content comparison without inheriting assume-unchanged/skip-worktree
    // flags from the repository's mutable index.
    execFileSync("git", trustedGitArgs(["update-index", "--really-refresh", "--ignore-submodules"]), {
      cwd,
      stdio: "ignore",
      timeout: 30_000,
      env,
    });
    execFileSync("git", trustedGitArgs(["diff-files", "--quiet", "--ignore-submodules=none", "--"]), {
      cwd,
      stdio: "ignore",
      timeout: 30_000,
      env,
    });
    return true;
  } catch {
    return false;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function resolveCheckCwd(validationRoot: string, configuredCwd?: string): string {
  const candidate = path.resolve(validationRoot, configuredCwd ?? ".");
  const relative = path.relative(validationRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`trusted verification cwd escapes validation worktree: ${configuredCwd}`);
  }
  const realRoot = fs.realpathSync(validationRoot);
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(realRoot, realCandidate);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`trusted verification cwd resolves outside validation worktree: ${configuredCwd}`);
  }
  return realCandidate;
}

function assertCheckExecutableScoped(validationRoot: string, checkCwd: string, executable: string): void {
  if (path.isAbsolute(executable) || (!executable.includes("/") && !executable.includes("\\"))) return;
  const candidate = path.resolve(checkCwd, executable);
  const relative = path.relative(validationRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`trusted verification executable escapes validation worktree: ${executable}`);
  }
  if (fs.existsSync(candidate)) {
    const realRoot = fs.realpathSync(validationRoot);
    const realCandidate = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`trusted verification executable resolves outside validation worktree: ${executable}`);
    }
  }
}

function assertRuntimeConfig(config: TrustedVerificationConfig): void {
  if (!config.enabled) return;
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_TRUSTED_VERIFICATION_CONFIG_BYTES) {
    throw new Error(`trusted verification configuration exceeds ${MAX_TRUSTED_VERIFICATION_CONFIG_BYTES} bytes`);
  }
  if (config.checks.length === 0 || config.checks.length > 64) {
    throw new Error("trusted verification requires between 1 and 64 checks");
  }
  const ids = new Set<string>();
  for (const [index, check] of config.checks.entries()) {
    if (typeof check.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(check.id) || ids.has(check.id)) {
      throw new Error(`trusted verification check id is invalid or duplicated at index ${index}`);
    }
    ids.add(check.id);
    if (typeof check.name !== "string" || !check.name.trim() || !isCommandSpec(check.command)) {
      throw new Error(`trusted verification check is invalid at index ${index}`);
    }
  }
}

interface SandboxBackendSelection {
  backend: TrustedVerificationSandboxBackend;
  executable: string;
  receipt: TrustedVerificationSandboxReceipt;
}

interface SandboxedProcessOptions {
  selection: SandboxBackendSelection;
  executable: string;
  argv: string[];
  cwd: string;
  validationRoot: string;
  cacheRoot: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

interface SandboxedProcessOutcome {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
  processContainment: TrustedVerificationProcessContainment;
}

interface SerializedSupervisorOutcome {
  supervisorPid?: number;
  requestNonce?: string | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: { code?: string; message: string } | null;
  processContainment: TrustedVerificationProcessContainment;
}

interface MacSandboxIdentity {
  censusExecutable: string;
  allowedPath: string;
  deniedPath: string;
}

const SANDBOX_RECEIPTS: Record<TrustedVerificationSandboxBackend, TrustedVerificationSandboxReceipt> = {
  "macos-sandbox-exec": {
    backend: "macos-sandbox-exec",
    profile: "deny-default-v1",
    enforced: true,
    networkDenied: true,
    ambientCredentialsStripped: true,
    validationWorktreeWritable: true,
    sourceRepositoryReadDenied: true,
    descendantProcessContainment: "isolated-process-lifetime-v1",
  },
  "linux-bwrap": {
    backend: "linux-bwrap",
    profile: "deny-default-v1",
    enforced: true,
    networkDenied: true,
    ambientCredentialsStripped: true,
    validationWorktreeWritable: true,
    sourceRepositoryReadDenied: true,
    descendantProcessContainment: "isolated-process-lifetime-v1",
  },
};

function isWithinOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }).map((candidate) => {
    try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
  }))];
}

function executableCandidates(name: string): string[] {
  const candidates = [
    path.join(path.dirname(process.execPath), name),
    "/Library/Developer/CommandLineTools/usr/bin/" + name,
    "/usr/bin/" + name,
    "/bin/" + name,
    "/usr/sbin/" + name,
    "/sbin/" + name,
  ];
  return [...new Set(candidates)];
}

function resolveExecutable(executable: string, cwd: string): string {
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : executable.includes("/") || executable.includes("\\")
      ? [path.resolve(cwd, executable)]
      : executableCandidates(executable);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue through the deterministic search list.
    }
  }
  throw new Error(`trusted verification executable is unavailable: ${executable}`);
}

function assertResolvedExecutableOutsideSource(sourceRoot: string, validationRoot: string, executable: string): void {
  const resolved = fs.realpathSync(executable);
  if (isWithinOrEqual(sourceRoot, resolved) && !isWithinOrEqual(validationRoot, resolved)) {
    throw new Error(`trusted verification executable resolves into protected source repository: ${executable}`);
  }
}

function nodeRuntimeRoot(): string {
  const resolved = fs.realpathSync(process.execPath);
  return path.dirname(path.dirname(resolved));
}

function packageToolRoot(executable: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = executable.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const packageStart = markerIndex + marker.length;
    const components = executable.slice(packageStart).split(path.sep);
    const packageComponents = components[0]?.startsWith("@") ? components.slice(0, 2) : components.slice(0, 1);
    if (packageComponents.length > 0 && packageComponents.every(Boolean)) {
      return executable.slice(0, packageStart) + packageComponents.join(path.sep);
    }
  }
  const cellarMarker = `${path.sep}Cellar${path.sep}`;
  const cellarIndex = executable.indexOf(cellarMarker);
  if (cellarIndex >= 0) {
    const prefix = executable.slice(0, cellarIndex + cellarMarker.length);
    const [formula, version] = executable.slice(prefix.length).split(path.sep);
    if (formula && version) return path.join(prefix, formula, version);
  }
  return null;
}

function macSystemReadPaths(): string[] {
  return existingPaths([
    "/System/Library",
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/sbin",
    "/private/etc/ssl",
    "/private/etc/localtime",
    "/private/var/select",
    "/private/var/db/timezone",
    "/Library/Developer/CommandLineTools",
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
  ]);
}

function executableReadPaths(executable: string, validationRoot: string): string[] {
  const resolvedExecutable = fs.realpathSync(executable);
  const runtimeRoot = nodeRuntimeRoot();
  const paths = [runtimeRoot];
  if (!isWithinOrEqual(validationRoot, resolvedExecutable)) {
    paths.push(packageToolRoot(resolvedExecutable) ?? resolvedExecutable);
  }
  return existingPaths(paths);
}

function sandboxQuote(value: string): string {
  return JSON.stringify(value);
}

function macSandboxProfile(params: {
  validationRoot: string;
  cacheRoot: string;
  executable: string;
  identityPath: string;
}): string {
  const readPaths = existingPaths([
    ...macSystemReadPaths(),
    ...executableReadPaths(params.executable, params.validationRoot),
    params.validationRoot,
    params.cacheRoot,
  ]);
  const writePaths = existingPaths([params.validationRoot, params.cacheRoot]);
  // dyld reads the root vnode itself while resolving the shared cache. Grant
  // data access to that single vnode (not its descendants) so executables can
  // start without widening the path allowlist.
  const readRules = [`(literal "/")`, ...readPaths.map((candidate) => `(subpath ${sandboxQuote(candidate)})`)].join(" ");
  const writeRules = writePaths.map((candidate) => `(subpath ${sandboxQuote(candidate)})`).join(" ");
  const metadataRules = existingPaths([
    ...readPaths.flatMap((candidate) => {
      const parents: string[] = [];
      let current = candidate;
      while (current !== path.dirname(current)) {
        current = path.dirname(current);
        parents.push(current);
      }
      return parents;
    }),
    ...readPaths,
  ]).map((candidate) => `(literal ${sandboxQuote(candidate)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    // The outer runner places sandbox-exec in a fresh process group, then
    // terminates that entire group after the direct command exits. Prevent a
    // sandboxed descendant from escaping that lifetime boundary by creating a
    // new process group or session. `process-fork`/`process-exec` remain
    // available because package scripts and compilers legitimately need them.
    "(deny syscall-unix (syscall-number SYS_setpgid) (syscall-number SYS_setsid))",
    "(allow process*)",
    "(allow sysctl-read)",
    // V8 requires executable-memory/JIT permission even for a bounded `node
    // -e` capability probe. This does not grant filesystem, IPC, or network
    // access; those remain controlled by the explicit deny/allow rules.
    "(allow dynamic-code-generation)",
    `(allow file-read* ${readRules})`,
    `(allow file-read-metadata ${metadataRules})`,
    `(allow file-write* ${writeRules} (literal \"/dev/null\"))`,
    // Unique pre-created marker used only to identify this profile's inherited
    // descendants. Data writes are allowed, but create/unlink are not, so an
    // untrusted process cannot remove the census identity.
    `(allow file-write-data (literal ${sandboxQuote(params.identityPath)}))`,
  ].join("\n");
}

function linuxSystemReadPaths(): string[] {
  return existingPaths([
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/ssl/certs",
    "/etc/ca-certificates",
  ]);
}

function mountParentDirectories(targets: string[]): string[] {
  const directories = new Set<string>();
  for (const target of targets) {
    let current = path.dirname(target);
    while (current !== "/" && current !== path.dirname(current)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return [...directories].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
}

function sanitizedPath(executable: string, validationRoot: string): string {
  return [...new Set([
    path.dirname(process.execPath),
    path.dirname(executable),
    path.join(validationRoot, "node_modules", ".bin"),
    // `/usr/bin/git` is an xcrun shim on macOS. Inside the deny-default
    // Seatbelt profile it cannot resolve `/var/select/developer_dir`, while
    // the already allowlisted CommandLineTools binary is self-contained.
    // Prefer that binary for nested validation commands as well as for the
    // verifier's own executable resolution.
    ...(process.platform === "darwin" && fs.existsSync("/Library/Developer/CommandLineTools/usr/bin")
      ? ["/Library/Developer/CommandLineTools/usr/bin"]
      : []),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(path.delimiter);
}

const MAC_SANDBOX_CENSUS_SOURCE = String.raw`#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <unistd.h>

enum sandbox_filter_type { SANDBOX_FILTER_NONE, SANDBOX_FILTER_PATH };
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;
extern int sandbox_check(pid_t pid, const char *operation, enum sandbox_filter_type filter_type, ...);

static int same_user_and_profile(pid_t pid, uid_t expected_uid, const char *allowed, const char *denied) {
  struct proc_bsdinfo info;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes != sizeof(info) || info.pbi_uid != expected_uid) return 0;
  return sandbox_check(pid, "file-write-data", SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, allowed) == 0
    && sandbox_check(pid, "file-write-data", SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, denied) != 0;
}

int main(int argc, char **argv) {
  if (argc != 4) return 64;
  int signal_number = 0;
  if (strcmp(argv[3], "stop") == 0) signal_number = SIGSTOP;
  else if (strcmp(argv[3], "kill") == 0) signal_number = SIGKILL;
  else if (strcmp(argv[3], "list") != 0) return 65;
  int capacity = proc_listallpids(NULL, 0);
  if (capacity <= 0) return 66;
  int count = 0;
  int slots = capacity + 64;
  pid_t *pids = NULL;
  for (int attempt = 0; attempt < 4; attempt++) {
    pids = calloc((size_t)slots, sizeof(pid_t));
    if (!pids) return 67;
    /* proc_listallpids returns a PID count, not a byte count. Retry when the
       buffer filled because concurrent forks may have grown the process table
       between the sizing and census calls. */
    count = proc_listallpids(pids, slots * (int)sizeof(pid_t));
    if (count < 0) { free(pids); return 68; }
    if (count < slots) break;
    free(pids);
    pids = NULL;
    slots *= 2;
  }
  if (!pids || count >= slots) { free(pids); return 69; }
  uid_t expected_uid = geteuid();
  for (int i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 1 || pid == getpid()) continue;
    if (!same_user_and_profile(pid, expected_uid, argv[1], argv[2])) continue;
    if (signal_number != 0) {
      /* Re-run the effective-UID and exact random profile fingerprint in the
         same helper immediately before every signal. */
      if (!same_user_and_profile(pid, expected_uid, argv[1], argv[2])) continue;
      if (kill(pid, signal_number) != 0) continue;
    }
    printf("%d\n", pid);
  }
  free(pids);
  return 0;
}
`;

function prepareMacSandboxIdentity(supervisorRoot: string): MacSandboxIdentity {
  const canonicalRoot = fs.realpathSync(supervisorRoot);
  const sourcePath = path.join(canonicalRoot, ".trusted-sandbox-census.c");
  const censusExecutable = path.join(canonicalRoot, ".trusted-sandbox-census");
  if (!fs.existsSync(censusExecutable)) {
    writeExclusiveNoFollow(sourcePath, MAC_SANDBOX_CENSUS_SOURCE);
    try {
      execFileSync("/usr/bin/clang", ["-O2", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", censusExecutable], {
        cwd: canonicalRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: canonicalRoot, TMPDIR: canonicalRoot },
      });
      fs.chmodSync(censusExecutable, 0o700);
      const stat = fs.lstatSync(censusExecutable);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("native sandbox census output is not a regular file");
    } finally {
      try { fs.unlinkSync(sourcePath); } catch (error) {
        if (!pathError(error, "ENOENT")) throw error;
      }
    }
  }
  const token = crypto.randomBytes(16).toString("hex");
  const identity = {
    censusExecutable,
    allowedPath: path.join(canonicalRoot, `.sandbox-identity-allowed-${token}`),
    deniedPath: path.join(canonicalRoot, `.sandbox-identity-denied-${token}`),
  };
  writeExclusiveNoFollow(identity.allowedPath, "allowed identity\n");
  writeExclusiveNoFollow(identity.deniedPath, "denied identity\n");
  return identity;
}

function removeMacSandboxIdentity(identity: MacSandboxIdentity): void {
  for (const marker of [identity.allowedPath, identity.deniedPath]) {
    try { fs.unlinkSync(marker); } catch (error) {
      if (!pathError(error, "ENOENT")) throw error;
    }
  }
}

function runMacSandboxCensus(identity: MacSandboxIdentity, action: "list" | "stop" | "kill"): number[] {
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

function terminateMacSandboxIdentity(identity: MacSandboxIdentity): TrustedVerificationProcessContainment {
  const observed = new Set<number>();
  let previous: number[] = [];
  let stable = false;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    // The helper re-censuses UID + both random policy paths immediately before
    // each SIGSTOP; callers never signal a PID from a stale list.
    const stopped = runMacSandboxCensus(identity, "stop");
    stopped.forEach((pid) => observed.add(pid));
    if (samePidSet(stopped, previous)) {
      stable = true;
      break;
    }
    previous = stopped;
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

  const killed = runMacSandboxCensus(identity, "kill");
  killed.forEach((pid) => observed.add(pid));
  const deadline = Date.now() + 2_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const remaining = runMacSandboxCensus(identity, "list");
    if (remaining.length === 0) {
      return {
        isolatedProcessGroup: true,
        descendantsTerminated: true,
        cleanupSignal: observed.size > 0 ? "SIGKILL" : null,
        identityCensus: "macos-sandbox-check-v1",
        identityMatchesObserved: observed.size,
      };
    }
    // Re-census before STOP/KILL rather than using `remaining` as a signal
    // target list. This protects unrelated processes if a PID was recycled.
    runMacSandboxCensus(identity, "stop").forEach((pid) => observed.add(pid));
    runMacSandboxCensus(identity, "kill").forEach((pid) => observed.add(pid));
    Atomics.wait(sleeper, 0, 0, 25);
  }
  return {
    isolatedProcessGroup: true,
    descendantsTerminated: runMacSandboxCensus(identity, "list").length === 0,
    cleanupSignal: observed.size > 0 ? "SIGKILL" : null,
    identityCensus: "macos-sandbox-check-v1",
    identityMatchesObserved: observed.size,
  };
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (pathError(error, "ESRCH")) return false;
    // EPERM still proves that a process survived. Treat every other failure as
    // a containment failure rather than assuming the group disappeared.
    return true;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !pathError(error, "ESRCH");
  }
}

function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (processGroupExists(processGroupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(sleeper, 0, 0, Math.min(remaining, 25));
  }
  return true;
}

function terminateSandboxProcessGroup(processGroupId: number | undefined): TrustedVerificationProcessContainment {
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
  if (waitForProcessGroupExit(groupId, 250)) {
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
    descendantsTerminated: waitForProcessGroupExit(groupId, 2_000),
    cleanupSignal,
    identityCensus,
    identityMatchesObserved: 0,
  };
}

interface MaterializedTrustedSupervisor {
  path: string;
  sha256: typeof TRUSTED_PROCESS_SUPERVISOR_SHA256;
  device: number;
  inode: number;
  size: number;
}

function readBoundedRegularFileNoFollow(filePath: string, maximumBytes: number): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`trusted supervisor source is not a regular file: ${filePath}`);
    if (stat.size > maximumBytes) throw new Error(`trusted supervisor source exceeds ${maximumBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maximumBytes + 1 - total;
      if (remaining <= 0) throw new Error(`trusted supervisor source exceeds ${maximumBytes} bytes`);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > maximumBytes) throw new Error(`trusted supervisor source exceeds ${maximumBytes} bytes`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertTrustedProcessSupervisorBytes(bytes: Buffer): void {
  if (bytes.length === 0 || bytes.length > MAX_TRUSTED_PROCESS_SUPERVISOR_BYTES) {
    throw new Error("trusted process supervisor source has an invalid size");
  }
  const actual = sha256(bytes);
  if (actual !== TRUSTED_PROCESS_SUPERVISOR_SHA256) {
    throw new Error(`trusted process supervisor digest mismatch: expected ${TRUSTED_PROCESS_SUPERVISOR_SHA256}, got ${actual}`);
  }
}

function materializeTrustedProcessSupervisor(supervisorRoot: string): MaterializedTrustedSupervisor {
  const canonicalRoot = fs.realpathSync(supervisorRoot);
  const sourcePath = fileURLToPath(new URL(`../${TRUSTED_PROCESS_SUPERVISOR_PATH}`, import.meta.url));
  const sourceBytes = readBoundedRegularFileNoFollow(sourcePath, MAX_TRUSTED_PROCESS_SUPERVISOR_BYTES);
  assertTrustedProcessSupervisorBytes(sourceBytes);
  const destination = path.join(canonicalRoot, `.trusted-process-supervisor-${crypto.randomBytes(16).toString("hex")}.mjs`);
  writeExclusiveNoFollow(destination, sourceBytes);
  fs.chmodSync(destination, 0o500);
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("private trusted process supervisor is not a private regular file");
  }
  const copiedBytes = readBoundedRegularFileNoFollow(destination, MAX_TRUSTED_PROCESS_SUPERVISOR_BYTES);
  assertTrustedProcessSupervisorBytes(copiedBytes);
  return {
    path: destination,
    sha256: TRUSTED_PROCESS_SUPERVISOR_SHA256,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
  };
}

function trustedProcessSupervisorCopyIntact(supervisor: MaterializedTrustedSupervisor): boolean {
  try {
    const stat = fs.lstatSync(supervisor.path);
    if (stat.isSymbolicLink() || !stat.isFile()
      || stat.dev !== supervisor.device || stat.ino !== supervisor.inode || stat.size !== supervisor.size
      || (stat.mode & 0o077) !== 0) return false;
    const bytes = readBoundedRegularFileNoFollow(supervisor.path, MAX_TRUSTED_PROCESS_SUPERVISOR_BYTES);
    assertTrustedProcessSupervisorBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

function removeTrustedProcessSupervisorCopy(supervisor: MaterializedTrustedSupervisor): boolean {
  const intact = trustedProcessSupervisorCopyIntact(supervisor);
  try {
    fs.unlinkSync(supervisor.path);
  } catch {
    return false;
  }
  return intact;
}

function spawnContainedProcess(
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    shell: false;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
  },
  supervisorRoot: string,
  sandboxIdentity?: MacSandboxIdentity,
): SandboxedProcessOutcome {
  // The authenticated helper is itself launched as the detached group leader.
  // spawnSync exposes that direct child PID, so the parent owns kill authority;
  // no PID supplied by helper output or a mutable pidfile is ever trusted.
  const canonicalSupervisorRoot = fs.realpathSync(supervisorRoot);
  const runtimeExecutableBefore = captureRuntimeExecutableIdentity(process.execPath);
  const supervisor = materializeTrustedProcessSupervisor(canonicalSupervisorRoot);
  const requestNonce = crypto.randomBytes(32).toString("hex");
  const request = {
    executable,
    argv,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeout,
    maxBufferBytes: options.maxBuffer,
    requestNonce,
    sandboxIdentity,
  };
  // Node/libuv honors `detached` for spawnSync on POSIX (and exposes the
  // resulting direct PID), although older @types/node releases omit it from
  // the synchronous option interface.
  const helperOptions: SpawnSyncOptionsWithStringEncoding & { detached: true } = {
    cwd: canonicalSupervisorRoot,
    shell: false,
    detached: true,
    encoding: "utf8",
    input: JSON.stringify(request),
    timeout: options.timeout + 10_000,
    maxBuffer: Math.max(36 * 1024 * 1024, options.maxBuffer * 7),
    env: { PATH: path.dirname(process.execPath), NO_COLOR: "1" },
  };
  const helper = spawnSync(process.execPath, [supervisor.path], helperOptions);

  let response: SerializedSupervisorOutcome | null = null;
  if (helper.status === 0 && typeof helper.stdout === "string") {
    try { response = JSON.parse(helper.stdout) as SerializedSupervisorOutcome; } catch { response = null; }
  }
  const processGroupId = Number.isSafeInteger(helper.pid) && helper.pid > 1 ? helper.pid : undefined;
  const parentGroupCleanup = terminateSandboxProcessGroup(processGroupId);
  const parentIdentityCleanup = sandboxIdentity
    ? terminateMacSandboxIdentity(sandboxIdentity)
    : {
      isolatedProcessGroup: true as const,
      descendantsTerminated: true,
      cleanupSignal: null,
      identityCensus: "linux-pid-namespace-v1" as const,
      identityMatchesObserved: 0,
    };
  let runtimeExecutableIntact = false;
  try {
    runtimeExecutableIntact = sameRuntimeExecutableIdentity(
      runtimeExecutableBefore,
      captureRuntimeExecutableIdentity(process.execPath),
    );
  } catch {
    runtimeExecutableIntact = false;
  }
  const supervisorCopyIntact = removeTrustedProcessSupervisorCopy(supervisor);

  const responseValid = response !== null
    && response.supervisorPid === processGroupId
    && response.requestNonce === requestNonce
    && response.processContainment?.isolatedProcessGroup === true
    && typeof response.processContainment.descendantsTerminated === "boolean"
    && response.processContainment.identityCensus === parentIdentityCleanup.identityCensus
    && Number.isSafeInteger(response.processContainment.identityMatchesObserved)
    && response.processContainment.identityMatchesObserved >= 0
    && runtimeExecutableIntact
    && supervisorCopyIntact;
  const descendantsTerminated = Boolean(processGroupId)
    && parentGroupCleanup.descendantsTerminated
    && parentIdentityCleanup.descendantsTerminated
    && responseValid;
  const processContainment: TrustedVerificationProcessContainment = {
    isolatedProcessGroup: true,
    descendantsTerminated,
    cleanupSignal: parentIdentityCleanup.cleanupSignal
      ?? parentGroupCleanup.cleanupSignal
      ?? response?.processContainment.cleanupSignal
      ?? null,
    identityCensus: parentIdentityCleanup.identityCensus,
    identityMatchesObserved: parentIdentityCleanup.identityMatchesObserved
      + (responseValid ? response!.processContainment.identityMatchesObserved : 0),
  };
  try {
    if (sandboxIdentity) removeMacSandboxIdentity(sandboxIdentity);
  } catch {
    processContainment.descendantsTerminated = false;
  }

  if (!responseValid) {
    const helperMessage = !runtimeExecutableIntact
      ? "trusted runtime executable changed during supervisor execution"
      : !supervisorCopyIntact
      ? "private trusted process supervisor changed during execution"
      : helper.error?.message
      ?? String(helper.stderr || "trusted process supervisor returned invalid output").trim();
    const helperCode = !runtimeExecutableIntact
      ? "ESUPERVISORRUNTIME"
      : !supervisorCopyIntact
      ? "ESUPERVISORINTEGRITY"
      : helper.error && "code" in helper.error
        ? String(helper.error.code)
        : "ESUPERVISOR";
    return {
      pid: processGroupId,
      status: null,
      signal: helper.signal,
      stdout: "",
      stderr: helperMessage,
      error: Object.assign(new Error(helperMessage), { code: helperCode }),
      processContainment,
    };
  }

  const serializedError = response!.error;
  return {
    pid: processGroupId,
    status: response!.status,
    signal: response!.signal,
    stdout: response!.stdout,
    stderr: response!.stderr,
    error: serializedError
      ? Object.assign(new Error(serializedError.message), { code: serializedError.code })
      : undefined,
    processContainment,
  };
}

function runSandboxedProcess(options: SandboxedProcessOptions): SandboxedProcessOutcome {
  const resolvedExecutable = resolveExecutable(options.executable, options.cwd);
  const env = { ...options.env, PATH: sanitizedPath(resolvedExecutable, options.validationRoot) };
  if (options.selection.backend === "macos-sandbox-exec") {
    const supervisorRoot = path.dirname(options.validationRoot);
    const sandboxIdentity = prepareMacSandboxIdentity(supervisorRoot);
    const profile = macSandboxProfile({
      validationRoot: options.validationRoot,
      cacheRoot: options.cacheRoot,
      executable: resolvedExecutable,
      identityPath: sandboxIdentity.allowedPath,
    });
    return spawnContainedProcess(options.selection.executable, ["-p", profile, resolvedExecutable, ...options.argv], {
      cwd: options.cwd,
      shell: false,
      encoding: "utf8",
      timeout: options.timeout,
      maxBuffer: 5 * 1024 * 1024,
      env,
    }, supervisorRoot, sandboxIdentity);
  }

  const readPaths = existingPaths([
    ...linuxSystemReadPaths(),
    ...executableReadPaths(resolvedExecutable, options.validationRoot),
  ]).filter((candidate) => !isWithinOrEqual(options.validationRoot, candidate)
    && !isWithinOrEqual(options.cacheRoot, candidate));
  const mountTargets = [...readPaths, options.validationRoot, options.cacheRoot];
  // The outer process-group isolation already creates a new session. Omitting
  // bwrap's `--new-session` keeps the namespace init and every payload
  // descendant in that group as a second lifetime boundary; `--unshare-all`
  // also supplies a PID namespace whose init reaps/terminates stragglers.
  const args = ["--die-with-parent", "--unshare-all", "--cap-drop", "ALL", "--tmpfs", "/", "--tmpfs", "/tmp"];
  // Mount the fresh /tmp BEFORE creating bind parents and binding the
  // validation/cache roots: a later --tmpfs /tmp would shadow any roots
  // living under /tmp (e.g. os.tmpdir() on CI runners) and --chdir would
  // fail inside the namespace.
  for (const directory of mountParentDirectories(mountTargets)) args.push("--dir", directory);
  // Usr-merge compat: on modern distros /lib, /lib64, /bin, /sbin are
  // symlinks into /usr. existingPaths() drops them (the /usr subtrees are
  // ro-bound instead), but the kernel still resolves the ELF interpreter
  // by its literal path (e.g. /lib64/ld-linux-x86-64.so.2) — without the
  // compat symlinks execvp fails with ENOENT inside the namespace.
  for (const [link, target] of [["/lib", "usr/lib"], ["/lib64", "usr/lib64"], ["/bin", "usr/bin"], ["/sbin", "usr/sbin"]] as const) {
    try {
      if (fs.lstatSync(link).isSymbolicLink()) args.push("--symlink", target, link);
    } catch { /* host path absent — nothing to bridge */ }
  }
  for (const candidate of readPaths) args.push("--ro-bind", candidate, candidate);
  args.push("--bind", options.validationRoot, options.validationRoot);
  args.push("--bind", options.cacheRoot, options.cacheRoot);
  // /dev/null (and /dev/zero, harmlessly) must be writable: stdio:"ignore"
  // child spawns open /dev/null O_RDWR, which EACCES-fails on an ro-bind.
  args.push("--dir", "/dev", "--bind", "/dev/null", "/dev/null", "--bind", "/dev/zero", "/dev/zero");
  if (fs.existsSync("/dev/random")) args.push("--ro-bind", "/dev/random", "/dev/random");
  if (fs.existsSync("/dev/urandom")) args.push("--ro-bind", "/dev/urandom", "/dev/urandom");
  args.push("--proc", "/proc", "--clearenv");
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push("--setenv", key, value);
  }
  args.push("--chdir", options.cwd, resolvedExecutable, ...options.argv);
  const debugOutcome = spawnContainedProcess(options.selection.executable, args, {
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 5 * 1024 * 1024,
    env: {},
  }, path.dirname(options.validationRoot));
  (debugOutcome as { debugBwrapArgv?: string[] }).debugBwrapArgv = args;
  return debugOutcome;
}

function backendExecutable(platform: NodeJS.Platform): SandboxBackendSelection | null {
  if (platform === "darwin") {
    try {
      fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
      return {
        backend: "macos-sandbox-exec",
        executable: "/usr/bin/sandbox-exec",
        receipt: SANDBOX_RECEIPTS["macos-sandbox-exec"],
      };
    } catch { return null; }
  }
  if (platform === "linux") {
    for (const candidate of executableCandidates("bwrap")) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return {
          backend: "linux-bwrap",
          executable: fs.realpathSync(candidate),
          receipt: SANDBOX_RECEIPTS["linux-bwrap"],
        };
      } catch { /* keep searching */ }
    }
  }
  return null;
}

function sandboxCapabilityProbe(selection: SandboxBackendSelection): { ok: boolean; reason: string } {
  // macOS exposes its temporary directory through `/var` while Seatbelt
  // evaluates canonical `/private/var` paths. Keep every path handed to the
  // child canonical so an allowed write cannot be rejected solely because of
  // that system symlink.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-sandbox-probe-")));
  const validationRoot = path.join(scratch, "allowed");
  const cacheRoot = path.join(scratch, "cache");
  const deniedRead = path.join(scratch, "secret.txt");
  const deniedWrite = path.join(scratch, "outside.txt");
  let unrelatedPid: number | undefined;
  try {
    fs.mkdirSync(validationRoot, { mode: 0o700 });
    fs.mkdirSync(cacheRoot, { mode: 0o700 });
    fs.writeFileSync(deniedRead, "sandbox-probe-secret", { mode: 0o600 });
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    unrelated.unref();
    unrelatedPid = unrelated.pid;
    const probe = [
      "const fs=require('node:fs'),{spawn}=require('node:child_process');",
      "let denied=0;",
      "try { fs.readFileSync(process.argv[1]); } catch { denied++; }",
      "try { fs.writeFileSync(process.argv[2], 'escape'); } catch { denied++; }",
      "const sleeper=['-e','setTimeout(()=>{},60000)'];",
      "const grouped=spawn(process.execPath,sleeper,{stdio:'ignore'});",
      "grouped.once('error',(e)=>{try{fs.writeFileSync(process.argv[3],JSON.stringify({spawnError:String(e&&(e.message||e))}))}catch{}process.exit(94)}); grouped.unref();",
      "const detachedPids=[];",
      "for(let i=0;i<12;i++){const child=spawn(process.execPath,sleeper,{detached:true,stdio:'ignore'});child.once('error',()=>{});child.unref();if(Number.isSafeInteger(child.pid))detachedPids.push(child.pid)}",
      "setTimeout(()=>{fs.writeFileSync(process.argv[3],JSON.stringify({denied,groupedPid:grouped.pid,detachedPids}));process.exit(denied===2?0:91)},150);",
    ].join("");
    const outcome = runSandboxedProcess({
      selection,
      executable: process.execPath,
      argv: ["-e", probe, deniedRead, deniedWrite, path.join(validationRoot, "allowed.txt")],
      cwd: validationRoot,
      validationRoot,
      cacheRoot,
      env: { CI: "1", HOME: validationRoot, TMPDIR: validationRoot },
      timeout: 10_000,
    });
    let spawnedPids: number[] = [];
    let proofRaw = "";
    try {
      proofRaw = fs.readFileSync(path.join(validationRoot, "allowed.txt"), "utf8");
      const proof = JSON.parse(proofRaw) as {
        denied?: number;
        groupedPid?: number;
        detachedPids?: number[];
      };
      spawnedPids = [proof.groupedPid, ...(Array.isArray(proof.detachedPids) ? proof.detachedPids : [])]
        .filter((pid): pid is number => Number.isSafeInteger(pid) && (pid ?? 0) > 1);
    } catch { /* a missing/malformed proof fails below */ }
    const escapedPids = spawnedPids.filter(processExists);
    // Never signal raw child-reported PIDs here. The process-group/profile
    // cleanup above is the authenticated lifetime boundary; a reported PID
    // may already have been recycled to an unrelated same-UID process.
    const unrelatedSurvived = Number.isSafeInteger(unrelatedPid) && processExists(unrelatedPid!);
    const backendIdentityProof = selection.backend === "macos-sandbox-exec"
      ? outcome.processContainment.identityMatchesObserved >= 12
      : outcome.processContainment.identityCensus === "linux-pid-namespace-v1"
        && outcome.processContainment.identityMatchesObserved === 0;
    const ok = outcome.status === 0
      && outcome.processContainment.descendantsTerminated
      && spawnedPids.length >= 13
      && backendIdentityProof
      && escapedPids.length === 0
      && unrelatedSurvived
      && !fs.existsSync(deniedWrite);
    return {
      ok,
      reason: ok
        ? "capability probe passed"
        : `capability probe failed (${outcome.status === null ? outcome.error?.message ?? outcome.signal ?? "no exit status" : `exit ${outcome.status}`}; identity matches: ${outcome.processContainment.identityMatchesObserved}; escaped descendants: ${escapedPids.join(",") || "none"}; unrelated sibling survived: ${unrelatedSurvived}): ${String(outcome.stderr || outcome.stdout || "no output").trim().slice(0, 500)} | proof: ${proofRaw.slice(0, 300) || "none"} | argv: ${JSON.stringify((outcome as { debugBwrapArgv?: string[] }).debugBwrapArgv ?? []).slice(0, 2000)}`,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (Number.isSafeInteger(unrelatedPid) && (unrelatedPid ?? 0) > 1) {
      try { process.kill(unrelatedPid!, "SIGKILL"); } catch { /* already exited */ }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function selectTrustedVerificationSandbox(platform: NodeJS.Platform = process.platform): SandboxBackendSelection | null {
  const selection = backendExecutable(platform);
  return selection && sandboxCapabilityProbe(selection).ok ? selection : null;
}

export function detectTrustedVerificationSandboxBackend(platform: NodeJS.Platform = process.platform): TrustedVerificationSandboxReceipt | null {
  return selectTrustedVerificationSandbox(platform)?.receipt ?? null;
}

export function diagnoseTrustedVerificationSandboxBackend(platform: NodeJS.Platform = process.platform): {
  backend: TrustedVerificationSandboxBackend | null;
  available: boolean;
  reason: string;
} {
  const selection = backendExecutable(platform);
  if (!selection) return { backend: null, available: false, reason: `no supported sandbox executable for ${platform}` };
  const probe = sandboxCapabilityProbe(selection);
  return { backend: selection.backend, available: probe.ok, reason: probe.reason };
}

function validationEnvironment(validationRoot: string, cacheRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.PI_TELEMETRY = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.TMPDIR = path.join(validationRoot, ".verification-tmp");
  environment.HOME = path.join(validationRoot, ".verification-home");
  // The cache is deliberately fresh and lives beside the disposable checkout.
  // Reusing a source-tree cache would make a predictable, attacker-replaceable
  // path writable by the untrusted validation process. Offline bootstrap can
  // therefore fail when the lockfile needs packages that are not self-contained;
  // that is a fail-closed limitation, not grounds to widen the sandbox.
  environment.NPM_CONFIG_CACHE = cacheRoot;
  environment.NPM_CONFIG_USERCONFIG = path.join(validationRoot, ".verification-npmrc");
  environment.NPM_CONFIG_OFFLINE = "true";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  fs.mkdirSync(environment.TMPDIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(environment.HOME, { recursive: true, mode: 0o700 });
  writeExclusiveNoFollow(environment.NPM_CONFIG_USERCONFIG, "");
  return environment;
}

function pathError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function ensureDirectoryTreeNoSymlinks(root: string, candidate: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(canonicalRoot, absoluteCandidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`trusted verification artifact directory escapes source repository: ${candidate}`);
  }

  let current = canonicalRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`trusted verification artifact path contains a symbolic link: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`trusted verification artifact path component is not a directory: ${current}`);
      }
    } catch (error) {
      if (!pathError(error, "ENOENT")) throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!pathError(mkdirError, "EEXIST")) throw mkdirError;
      }
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`trusted verification artifact path was replaced during creation: ${current}`);
      }
    }
  }

  const canonicalCandidate = fs.realpathSync(absoluteCandidate);
  if (canonicalCandidate !== absoluteCandidate) {
    throw new Error(`trusted verification artifact directory is not canonical: ${candidate}`);
  }
  return canonicalCandidate;
}

function trustedArtifactDirectory(
  sourceRoot: string,
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
): string {
  const runDir = path.resolve(stateManager.getRunDir());
  return ensureDirectoryTreeNoSymlinks(
    sourceRoot,
    path.join(runDir, "cycles", String(state.cycle), "validate"),
  );
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`trusted verification private directory is not a real directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  if ((fs.statSync(directory).mode & 0o077) !== 0) {
    throw new Error(`trusted verification private directory permissions are too broad: ${directory}`);
  }
}

function openExclusiveNoFollow(filePath: string): number {
  return fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
}

function writeExclusiveNoFollow(filePath: string, bytes: string | Buffer): void {
  const descriptor = openExclusiveNoFollow(filePath);
  let completed = false;
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    completed = true;
  } finally {
    fs.closeSync(descriptor);
    if (!completed) {
      try { fs.unlinkSync(filePath); } catch { /* preserve the original write error */ }
    }
  }
}

function invalidateFixedReceipt(receiptPath: string): void {
  try {
    const stat = fs.lstatSync(receiptPath);
    if (stat.isDirectory()) {
      throw new Error(`trusted verification receipt path is a directory: ${receiptPath}`);
    }
    // unlink removes a symlink itself; it never follows the link target.
    fs.unlinkSync(receiptPath);
  } catch (error) {
    if (!pathError(error, "ENOENT")) throw error;
  }
}

function atomicallyReplaceReceipt(receiptPath: string, bytes: string): void {
  const directory = path.dirname(receiptPath);
  const temporaryPath = path.join(directory, `.trusted-receipt-${crypto.randomBytes(16).toString("hex")}.tmp`);
  writeExclusiveNoFollow(temporaryPath, bytes);
  try {
    try {
      const existing = fs.lstatSync(receiptPath);
      if (existing.isDirectory()) throw new Error(`trusted verification receipt path is a directory: ${receiptPath}`);
    } catch (error) {
      if (!pathError(error, "ENOENT")) throw error;
    }
    // POSIX rename replaces a symlink rather than following it, so publication
    // is both atomic and safe if a stale leaf is raced into place.
    fs.renameSync(temporaryPath, receiptPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (!pathError(error, "ENOENT")) throw error;
    }
  }
}

function createPrivateVerificationAttempt(runId: string, cycle: number): {
  root: string;
  validationRoot: string;
  cacheRoot: string;
} {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const runToken = sha256(runId).slice(0, 16);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, `pi-ig-verify-${runToken}-c${cycle}-`)));
  assertPrivateDirectory(root);
  const validationRoot = path.join(root, "checkout");
  const cacheRoot = path.join(root, "npm-cache");
  fs.mkdirSync(validationRoot, { mode: 0o700 });
  fs.mkdirSync(cacheRoot, { mode: 0o700 });
  assertPrivateDirectory(validationRoot);
  assertPrivateDirectory(cacheRoot);
  return { root, validationRoot, cacheRoot };
}

function writeProcessResult(params: {
  id: string;
  name: string;
  executable: string;
  argv: string[];
  configuredCwd: string;
  validationSha: string;
  artifact: string;
  startedAt: string;
  outcome: SandboxedProcessOutcome;
}): TrustedVerificationResult {
  const timedOut = Boolean(params.outcome.error && "code" in params.outcome.error && params.outcome.error.code === "ETIMEDOUT");
  const exitCode = typeof params.outcome.status === "number" ? params.outcome.status : null;
  const endedAt = new Date().toISOString();
  const artifactBytes = [
    `Started: ${params.startedAt}`,
    `Ended: ${endedAt}`,
    `Executable: ${params.executable}`,
    `Argv: ${JSON.stringify(params.argv)}`,
    `Cwd: ${params.configuredCwd}`,
    `Validation SHA: ${params.validationSha}`,
    `Exit code: ${exitCode ?? "none"}`,
    `Signal: ${params.outcome.signal ?? "none"}`,
    `Timed out: ${timedOut}`,
    `Process group isolated: ${params.outcome.processContainment.isolatedProcessGroup}`,
    `Descendants terminated: ${params.outcome.processContainment.descendantsTerminated}`,
    `Containment cleanup signal: ${params.outcome.processContainment.cleanupSignal ?? "none"}`,
    `Identity census: ${params.outcome.processContainment.identityCensus}`,
    `Identity matches observed: ${params.outcome.processContainment.identityMatchesObserved}`,
    "",
    "STDOUT:",
    (params.outcome.stdout ?? "").slice(0, 2_000_000),
    "",
    "STDERR:",
    (params.outcome.stderr ?? params.outcome.error?.message ?? "").slice(0, 2_000_000),
  ].join("\n");
  writeExclusiveNoFollow(params.artifact, artifactBytes);
  return {
    id: params.id,
    name: params.name,
    status: exitCode === 0 && params.outcome.processContainment.descendantsTerminated ? "PASS" : "FAIL",
    exitCode,
    artifact: params.artifact,
    startedAt: params.startedAt,
    endedAt,
    artifactSha256: sha256(artifactBytes),
    timedOut,
    signal: params.outcome.signal ?? null,
    processContainment: params.outcome.processContainment,
  };
}

function writeNotRunResult(params: {
  id: string;
  name: string;
  executable: string;
  argv: string[];
  configuredCwd: string;
  validationSha: string;
  artifact: string;
  reason: string;
}): TrustedVerificationResult {
  const startedAt = new Date().toISOString();
  const endedAt = new Date().toISOString();
  const identityCensus = process.platform === "darwin"
    ? "macos-sandbox-check-v1" as const
    : "linux-pid-namespace-v1" as const;
  const artifactBytes = [
    `Started: ${startedAt}`,
    `Ended: ${endedAt}`,
    `Executable: ${params.executable}`,
    `Argv: ${JSON.stringify(params.argv)}`,
    `Cwd: ${params.configuredCwd}`,
    `Validation SHA: ${params.validationSha}`,
    "Status: NOT_RUN",
    `Reason: ${params.reason}`,
    "Exit code: none",
    "Signal: none",
    "Timed out: false",
    "Process group isolated: false",
    "Descendants terminated: true",
    "Containment cleanup signal: none",
    `Identity census: ${identityCensus}`,
    "Identity matches observed: 0",
  ].join("\n");
  writeExclusiveNoFollow(params.artifact, artifactBytes);
  return {
    id: params.id,
    name: params.name,
    status: "NOT_RUN",
    exitCode: null,
    artifact: params.artifact,
    startedAt,
    endedAt,
    artifactSha256: sha256(artifactBytes),
    timedOut: false,
    signal: null,
    processContainment: {
      isolatedProcessGroup: false,
      descendantsTerminated: true,
      cleanupSignal: null,
      identityCensus,
      identityMatchesObserved: 0,
    },
  };
}

function createDetachedValidationCheckout(sourceRoot: string, validationRoot: string, sourceSha: string): void {
  // A linked worktree stores its Git directory under the protected source
  // repository. Sandboxed `git` checks would then either fail or require a
  // dangerous source `.git` write exception. A shallow local fetch copies the
  // exact commit into a self-contained repository instead.
  fs.rmdirSync(validationRoot);
  execFileSync("git", trustedGitArgs(["init", "-q", validationRoot]), {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: trustedGitEnvironment(),
  });
  execFileSync("git", trustedGitArgs(["-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--depth=1", sourceRoot, sourceSha]), {
    cwd: validationRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: trustedGitEnvironment(),
  });
  execFileSync("git", trustedGitArgs(["checkout", "--quiet", "--detach", sourceSha]), {
    cwd: validationRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: trustedGitEnvironment(),
  });
}

function removeValidationCheckout(validationRoot: string): void {
  // Removal is scoped to the freshly minted managed validation directory.
  fs.rmSync(validationRoot, { recursive: true, force: true });
}

function selectedNpmLockfile(repositoryRoot: string): string | null {
  // npm gives shrinkwrap precedence when both files exist. lstat intentionally
  // treats a dangling symlink as present so materialization rejects it rather
  // than silently falling through to a less authoritative lock.
  for (const filename of ["npm-shrinkwrap.json", "package-lock.json"]) {
    const candidate = path.join(repositoryRoot, filename);
    try {
      fs.lstatSync(candidate);
      return candidate;
    } catch (error) {
      if (!pathError(error, "ENOENT")) throw error;
    }
  }
  return null;
}

export function runTrustedVerification(params: {
  cwd: string;
  state: IterativeGoalState;
  stateManager: StateManagerAPI;
  config?: TrustedVerificationConfig;
}): TrustedVerificationReceiptV1 | null {
  const sourceRoot = resolveRepositoryRoot(params.cwd);
  const config = params.config ?? loadTrustedVerificationConfig(sourceRoot);
  if (!config.enabled) return null;
  assertRuntimeConfig(config);
  if (!params.state.signing.available || !params.state.signing.privateKeyPem) {
    throw new Error("trusted verification requires the active run evidence signer");
  }

  const startedAt = new Date().toISOString();
  const sourceSha = git(sourceRoot, ["rev-parse", "HEAD"]);
  const artifactDir = trustedArtifactDirectory(sourceRoot, params.state, params.stateManager);
  const receiptPath = path.join(artifactDir, "trusted-verification-receipt.json");
  // A new verifier attempt supersedes any older receipt for this cycle. If
  // this attempt crashes before signing, the prior PASS cannot survive it.
  invalidateFixedReceipt(receiptPath);
  const runtimeExecutableBefore = captureRuntimeExecutableIdentity(process.execPath);
  const sandboxSelection = selectTrustedVerificationSandbox();
  if (!sandboxSelection) {
    throw new Error("trusted verification requires an enforceable OS sandbox (macOS sandbox-exec or Linux bubblewrap); no backend passed the capability probe");
  }
  const sourceTrackedTreeCleanBefore = trackedTreeClean(sourceRoot);
  if (!sourceTrackedTreeCleanBefore) {
    throw new Error("trusted verification requires a clean tracked source tree at current HEAD");
  }
  const privateAttempt = createPrivateVerificationAttempt(params.state.runId, params.state.cycle);
  const validationRoot = privateAttempt.validationRoot;
  const cacheRoot = privateAttempt.cacheRoot;
  const artifactAttemptDir = fs.mkdtempSync(path.join(artifactDir, "trusted-attempt-"));
  assertPrivateDirectory(artifactAttemptDir);
  const results: TrustedVerificationResult[] = [];
  const resultsPath = path.join(artifactAttemptDir, "trusted-verification-results.jsonl");
  const resultsDescriptor = openExclusiveNoFollow(resultsPath);
  let validationSha = "";
  let validationShaAfter = "";
  let validationTrackedTreeClean = false;
  let dependencyMaterialization: TrustedNpmMaterializationReceipt | null = null;
  let dependencyBootstrap: TrustedVerificationResult | null = null;

  try {
    createDetachedValidationCheckout(sourceRoot, validationRoot, sourceSha);
    validationSha = git(validationRoot, ["rev-parse", "HEAD"]);
    const npmLockfile = selectedNpmLockfile(validationRoot);
    if (npmLockfile) {
      dependencyMaterialization = materializeTrustedNpmCache({
        lockfilePath: npmLockfile,
        cacheRoot,
        sourceRoot: validationRoot,
      });
    }
    const env = validationEnvironment(validationRoot, cacheRoot);

    if (npmLockfile && dependencyMaterialization?.status === "PASS") {
      const bootstrapStartedAt = new Date().toISOString();
      const executable = process.platform === "win32" ? "npm.cmd" : "npm";
      const argv = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
      const resolvedExecutable = resolveExecutable(executable, validationRoot);
      assertResolvedExecutableOutsideSource(sourceRoot, validationRoot, resolvedExecutable);
      const outcome = runSandboxedProcess({
        selection: sandboxSelection,
        executable: resolvedExecutable,
        argv,
        cwd: validationRoot,
        validationRoot,
        cacheRoot,
        env,
        timeout: 600_000,
      });
      dependencyBootstrap = writeProcessResult({
        id: "dependency-bootstrap",
        name: "Lockfile dependency bootstrap (integrity-verified private cache; offline; lifecycle scripts disabled)",
        executable,
        argv,
        configuredCwd: ".",
        validationSha,
        artifact: path.join(artifactAttemptDir, "trusted-dependency-bootstrap.txt"),
        startedAt: bootstrapStartedAt,
        outcome,
      });
    } else if (npmLockfile) {
      dependencyBootstrap = writeNotRunResult({
        id: "dependency-bootstrap",
        name: "Lockfile dependency bootstrap (integrity-verified private cache; offline; lifecycle scripts disabled)",
        executable: process.platform === "win32" ? "npm.cmd" : "npm",
        argv: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        configuredCwd: ".",
        validationSha,
        artifact: path.join(artifactAttemptDir, "trusted-dependency-bootstrap.txt"),
        reason: `dependency materialization failed: ${dependencyMaterialization?.error ?? "unknown failure"}`,
      });
    }

    const prerequisiteFailure = dependencyMaterialization?.status === "FAIL"
      ? `dependency materialization failed: ${dependencyMaterialization.error ?? "unknown failure"}`
      : dependencyBootstrap?.status !== undefined && dependencyBootstrap.status !== "PASS"
        ? "dependency bootstrap did not pass"
        : null;
    for (const check of config.checks) {
      const command = check.command;
      const artifact = path.join(artifactAttemptDir, `trusted-${check.id}.txt`);
      if (prerequisiteFailure) {
        const result = writeNotRunResult({
          id: check.id,
          name: check.name,
          executable: command?.executable ?? "missing",
          argv: command?.argv ?? [],
          configuredCwd: command?.cwd ?? ".",
          validationSha,
          artifact,
          reason: prerequisiteFailure,
        });
        fs.writeSync(resultsDescriptor, `${JSON.stringify(result)}\n`);
        fs.fsyncSync(resultsDescriptor);
        results.push(result);
        continue;
      }
      const checkStartedAt = new Date().toISOString();
      const checkCwd = resolveCheckCwd(validationRoot, command?.cwd);
      assertCheckExecutableScoped(validationRoot, checkCwd, command!.executable);
      const resolvedExecutable = resolveExecutable(command!.executable, checkCwd);
      assertResolvedExecutableOutsideSource(sourceRoot, validationRoot, resolvedExecutable);
      const outcome = command ? runSandboxedProcess({
        selection: sandboxSelection,
        executable: resolvedExecutable,
        argv: command.argv,
        cwd: checkCwd,
        validationRoot,
        cacheRoot,
        env,
        timeout: command.timeoutMs ?? 120_000,
      }) : null;
      const timedOut = Boolean(outcome?.error && "code" in outcome.error && outcome.error.code === "ETIMEDOUT");
      const exitCode = outcome && typeof outcome.status === "number" ? outcome.status : null;
      const status: VerificationResult["status"] = command && exitCode === 0
        && outcome?.processContainment.descendantsTerminated === true
        ? "PASS"
        : command
          ? "FAIL"
          : check.required
            ? "FAIL"
            : "NOT_RUN";
      const artifactBytes = [
        `Started: ${checkStartedAt}`,
        `Ended: ${new Date().toISOString()}`,
        `Executable: ${command?.executable ?? "missing"}`,
        `Argv: ${JSON.stringify(command?.argv ?? [])}`,
        `Cwd: ${command?.cwd ?? "."}`,
        `Validation SHA: ${validationSha}`,
        `Exit code: ${exitCode ?? "none"}`,
        `Signal: ${outcome?.signal ?? "none"}`,
        `Timed out: ${timedOut}`,
        `Process group isolated: ${outcome?.processContainment.isolatedProcessGroup ?? false}`,
        `Descendants terminated: ${outcome?.processContainment.descendantsTerminated ?? false}`,
        `Containment cleanup signal: ${outcome?.processContainment.cleanupSignal ?? "none"}`,
        `Identity census: ${outcome?.processContainment.identityCensus ?? "missing"}`,
        `Identity matches observed: ${outcome?.processContainment.identityMatchesObserved ?? 0}`,
        "",
        "STDOUT:",
        (outcome?.stdout ?? "").slice(0, 2_000_000),
        "",
        "STDERR:",
        (outcome?.stderr ?? outcome?.error?.message ?? "").slice(0, 2_000_000),
      ].join("\n");
      writeExclusiveNoFollow(artifact, artifactBytes);
      const result: TrustedVerificationResult = {
        id: check.id,
        name: check.name,
        status,
        exitCode,
        artifact,
        startedAt: checkStartedAt,
        endedAt: new Date().toISOString(),
        artifactSha256: sha256(artifactBytes),
        timedOut,
        signal: outcome?.signal ?? null,
        processContainment: outcome?.processContainment ?? {
          isolatedProcessGroup: true,
          descendantsTerminated: false,
          cleanupSignal: null,
          identityCensus: process.platform === "darwin" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1",
          identityMatchesObserved: 0,
        },
      };
      fs.writeSync(resultsDescriptor, `${JSON.stringify(result)}\n`);
      fs.fsyncSync(resultsDescriptor);
      results.push(result);
    }
    validationShaAfter = git(validationRoot, ["rev-parse", "HEAD"]);
    validationTrackedTreeClean = trackedTreeClean(validationRoot);
  } finally {
    try {
      fs.closeSync(resultsDescriptor);
    } finally {
      removeValidationCheckout(privateAttempt.root);
    }
  }

  const sourceShaAfter = git(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceTrackedTreeCleanAfter = trackedTreeClean(sourceRoot);
  let runtimeExecutableStable = false;
  try {
    runtimeExecutableStable = sameRuntimeExecutableIdentity(
      runtimeExecutableBefore,
      captureRuntimeExecutableIdentity(process.execPath),
    );
  } catch {
    runtimeExecutableStable = false;
  }
  const requiredFailed = config.checks.some((check) => check.required && results.find((result) => result.id === check.id)?.status !== "PASS");
  const allTreesClean = sourceTrackedTreeCleanBefore && sourceTrackedTreeCleanAfter && validationTrackedTreeClean;
  const receipt: TrustedVerificationReceiptV1 = {
    schema: TRUSTED_VERIFICATION_SCHEMA,
    runId: params.state.runId,
    cycle: params.state.cycle,
    sourceSha,
    sourceShaAfter,
    validationSha,
    validationShaAfter,
    sourceTrackedTreeCleanBefore,
    sourceTrackedTreeCleanAfter,
    validationTrackedTreeClean,
    trackedTreeClean: allTreesClean,
    startedAt,
    endedAt: new Date().toISOString(),
    checksHash: trustedVerificationConfigHash(config),
    resultsHash: sha256(results.map((result) => JSON.stringify(result)).join("\n")),
    sandbox: sandboxSelection.receipt,
    supervisorHelperSha256: TRUSTED_PROCESS_SUPERVISOR_SHA256,
    supervisorRuntimeExecutable: publicRuntimeExecutableIdentity(runtimeExecutableBefore),
    dependencyMaterialization,
    dependencyBootstrap,
    results,
    ok: (!dependencyMaterialization || dependencyMaterialization.status === "PASS")
      && (!dependencyBootstrap || dependencyBootstrap.status === "PASS")
      && !requiredFailed
      && sourceSha === sourceShaAfter
      && sourceSha === validationSha
      && validationSha === validationShaAfter
      && runtimeExecutableStable
      && allTreesClean,
  };
  const receiptBytes = JSON.stringify(receipt, null, 2);
  atomicallyReplaceReceipt(receiptPath, receiptBytes);
  const attestation = attestAction({
    runId: params.state.runId,
    cycle: params.state.cycle,
    phase: "validate",
    artifactPath: receiptPath,
    action: {
      id: `trusted-verification:${params.state.runId}:c${params.state.cycle}`,
      actor: { kind: "kernel", id: "trusted-verification-runner" },
      runId: params.state.runId,
      effect: "process.exec",
      resource: { type: "command", value: config.checks.map((check) => `${check.command?.executable ?? "missing"} ${check.command?.argv.join(" ") ?? ""}`).join(" && ") },
      input: {
        checksHash: receipt.checksHash,
        sourceSha,
        validationSha,
        validationShaAfter,
        sandboxBackend: receipt.sandbox.backend,
        sandboxProfile: receipt.sandbox.profile,
        descendantProcessContainment: receipt.sandbox.descendantProcessContainment,
        supervisorHelperSha256: receipt.supervisorHelperSha256,
        supervisorRuntimeExecutable: receipt.supervisorRuntimeExecutable,
        dependencyLockfileSha256: receipt.dependencyMaterialization?.lockfileSha256 ?? null,
        dependencyManifestSha256: receipt.dependencyMaterialization?.manifestSha256 ?? null,
        dependencyTarballs: receipt.dependencyMaterialization?.uniqueTarballs ?? 0,
        dependencyBytes: receipt.dependencyMaterialization?.verifiedBytes ?? 0,
        dependencyNetworkUsed: receipt.dependencyMaterialization?.networkUsed ?? false,
      },
      purpose: "kernel-owned delivered-HEAD verification",
      risk: "read",
      dataClassification: "internal",
    },
    outputBytes: receiptBytes,
    dlpScanId: null,
    trustClassification: "trusted_control_plane",
    signing: params.state.signing,
    sandboxProfile: `trusted-verification:${receipt.sandbox.backend}:${receipt.sandbox.profile}`,
  });
  params.stateManager.recordAttestation(attestation);
  return receipt;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readFileNoFollowWithin(root: string, candidate: string, maximumBytes: number): Buffer {
  const canonicalRoot = fs.realpathSync(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!isWithin(canonicalRoot, absoluteCandidate)) {
    throw new Error(`trusted verification artifact escapes its phase directory: ${candidate}`);
  }
  let current = canonicalRoot;
  for (const component of path.relative(canonicalRoot, absoluteCandidate).split(path.sep)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`trusted verification artifact path contains a symbolic link: ${current}`);
    }
  }
  const descriptor = fs.openSync(absoluteCandidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`trusted verification artifact is not a regular file: ${candidate}`);
    }
    if (stat.size > maximumBytes) {
      throw new Error(`trusted verification artifact exceeds ${maximumBytes} bytes: ${candidate}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error(`trusted verification artifact grew beyond ${maximumBytes} bytes: ${candidate}`);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function hasValidProcessContainment(
  result: TrustedVerificationResult,
  expectedIdentityCensus: TrustedVerificationProcessContainment["identityCensus"],
): boolean {
  const containment = result.processContainment;
  if (!containment
    || containment.descendantsTerminated !== true
    || !([null, "SIGTERM", "SIGKILL"] as const).includes(containment.cleanupSignal)
    || containment.identityCensus !== expectedIdentityCensus
    || !Number.isSafeInteger(containment.identityMatchesObserved)
    || containment.identityMatchesObserved < 0) return false;
  if (result.status === "NOT_RUN") {
    return result.exitCode === null
      && result.timedOut === false
      && result.signal === null
      && containment.isolatedProcessGroup === false
      && containment.cleanupSignal === null
      && containment.identityMatchesObserved === 0;
  }
  if (containment.isolatedProcessGroup !== true) return false;
  return result.status === (result.exitCode === 0 ? "PASS" : "FAIL");
}

export function readTrustedVerificationReceipt(cwd: string, state: IterativeGoalState, stateManager: StateManagerAPI): TrustedVerificationReceiptV1 | null {
  try {
    const repositoryRoot = resolveRepositoryRoot(cwd);
    const artifactRoot = trustedArtifactDirectory(repositoryRoot, state, stateManager);
    const receiptPath = path.join(artifactRoot, "trusted-verification-receipt.json");
    const receiptBytes = readFileNoFollowWithin(
      artifactRoot,
      receiptPath,
      MAX_TRUSTED_VERIFICATION_RECEIPT_BYTES,
    ).toString("utf8");
    const receipt = JSON.parse(receiptBytes) as TrustedVerificationReceiptV1;
    if (receipt.schema !== TRUSTED_VERIFICATION_SCHEMA || receipt.runId !== state.runId || receipt.cycle !== state.cycle) return null;
    if (!receipt.sandbox
      || !(["macos-sandbox-exec", "linux-bwrap"] as const).includes(receipt.sandbox.backend)
      || receipt.sandbox.profile !== "deny-default-v1"
      || receipt.sandbox.enforced !== true
      || receipt.sandbox.networkDenied !== true
      || receipt.sandbox.ambientCredentialsStripped !== true
      || receipt.sandbox.validationWorktreeWritable !== true
      || receipt.sandbox.sourceRepositoryReadDenied !== true
      || receipt.sandbox.descendantProcessContainment !== "isolated-process-lifetime-v1") return null;
    if (receipt.supervisorHelperSha256 !== TRUSTED_PROCESS_SUPERVISOR_SHA256) return null;
    const currentRuntimeExecutable = publicRuntimeExecutableIdentity(captureRuntimeExecutableIdentity(process.execPath));
    if (!receipt.supervisorRuntimeExecutable
      || receipt.supervisorRuntimeExecutable.path !== currentRuntimeExecutable.path
      || receipt.supervisorRuntimeExecutable.sha256 !== currentRuntimeExecutable.sha256
      || receipt.supervisorRuntimeExecutable.size !== currentRuntimeExecutable.size) return null;
    if (!Array.isArray(receipt.results) || typeof receipt.resultsHash !== "string" || typeof receipt.checksHash !== "string") return null;
    const currentSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    if (receipt.sourceSha !== receipt.sourceShaAfter
      || receipt.sourceSha !== receipt.validationSha
      || receipt.validationSha !== receipt.validationShaAfter
      || receipt.sourceSha !== currentSha) return null;
    if (!receipt.sourceTrackedTreeCleanBefore || !receipt.sourceTrackedTreeCleanAfter || !receipt.validationTrackedTreeClean || !receipt.trackedTreeClean) return null;
    if (!trackedTreeClean(repositoryRoot)) return null;
    const config = loadTrustedVerificationConfig(repositoryRoot);
    if (!config.enabled || trustedVerificationConfigHash(config) !== receipt.checksHash) return null;
    const configuredIds = config.checks.map((check) => check.id);
    const resultIds = receipt.results.map((result) => result.id);
    if (new Set(resultIds).size !== resultIds.length || JSON.stringify(configuredIds) !== JSON.stringify(resultIds)) return null;
    const requiredFailed = config.checks.some((check) => check.required
      && receipt.results.find((result) => result.id === check.id)?.status !== "PASS");
    const npmLockfile = selectedNpmLockfile(repositoryRoot);
    const expectsDependencyBootstrap = Boolean(npmLockfile);
    if (expectsDependencyBootstrap !== Boolean(receipt.dependencyMaterialization)
      || expectsDependencyBootstrap !== Boolean(receipt.dependencyBootstrap)) return null;
    if (receipt.dependencyMaterialization
      && (!npmLockfile || !trustedNpmMaterializationMatchesLock(receipt.dependencyMaterialization, npmLockfile, repositoryRoot))) return null;
    const expectedIdentityCensus = receipt.sandbox.backend === "macos-sandbox-exec"
      ? "macos-sandbox-check-v1"
      : "linux-pid-namespace-v1";
    if (receipt.dependencyBootstrap) {
      if (!hasValidProcessContainment(receipt.dependencyBootstrap, expectedIdentityCensus)) return null;
      if (sha256(readFileNoFollowWithin(
        artifactRoot,
        receipt.dependencyBootstrap.artifact,
        MAX_TRUSTED_VERIFICATION_ARTIFACT_BYTES,
      )) !== receipt.dependencyBootstrap.artifactSha256) return null;
    }
    const materializationPassed = !receipt.dependencyMaterialization
      || receipt.dependencyMaterialization.status === "PASS";
    const bootstrapPassed = !receipt.dependencyBootstrap || receipt.dependencyBootstrap.status === "PASS";
    const recomputedOk = materializationPassed && bootstrapPassed && !requiredFailed
      && receipt.sourceSha === receipt.sourceShaAfter
      && receipt.sourceSha === receipt.validationSha
      && receipt.validationSha === receipt.validationShaAfter
      && receipt.trackedTreeClean;
    if (receipt.ok !== recomputedOk || !receipt.ok) return null;
    if (sha256(receipt.results.map((result) => JSON.stringify(result)).join("\n")) !== receipt.resultsHash) return null;
    for (const result of receipt.results) {
      if (typeof result.artifact !== "string" || typeof result.artifactSha256 !== "string") return null;
      if (!hasValidProcessContainment(result, expectedIdentityCensus)) return null;
      if (sha256(readFileNoFollowWithin(
        artifactRoot,
        result.artifact,
        MAX_TRUSTED_VERIFICATION_ARTIFACT_BYTES,
      )) !== result.artifactSha256) return null;
    }
    const absoluteReceiptPath = path.resolve(receiptPath);
    const attestation = state.attestations.find((item) => path.resolve(item.path) === absoluteReceiptPath && item.sha256 === sha256(receiptBytes));
    if (!attestation) return null;
    const verified = verifyActionAttestation({
      attestation,
      publicKeyPem: state.signing.runPublicKey,
      artifactBytes: receiptBytes,
    });
    if (!verified.ok) return null;
    return receipt;
  } catch {
    return null;
  }
}
