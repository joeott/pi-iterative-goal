import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attestAction, verifyActionAttestation } from "./cyber-runtime.js";
import { readIterativeGoalSettings } from "./domain/project-settings.js";
import type { CommandSpec, VerificationResult, VerificationSpec } from "./domain/verification.js";
import type { StateManagerAPI } from "./state.js";
import type { IterativeGoalState } from "./types.js";

export const TRUSTED_VERIFICATION_SCHEMA = "pi-iterative-goal.trusted-verification.v3" as const;

export type TrustedVerificationSandboxBackend = "macos-sandbox-exec" | "linux-bwrap";

export interface TrustedVerificationSandboxReceipt {
  backend: TrustedVerificationSandboxBackend;
  profile: "deny-default-v1";
  enforced: true;
  networkDenied: true;
  ambientCredentialsStripped: true;
  validationWorktreeWritable: true;
  sourceRepositoryReadDenied: true;
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
  /** OS-enforced boundary used for dependency bootstrap and every check. */
  sandbox: TrustedVerificationSandboxReceipt;
  /** Lockfile-derived dependency install executed with lifecycle scripts disabled. */
  dependencyBootstrap: TrustedVerificationResult | null;
  results: TrustedVerificationResult[];
  ok: boolean;
}

function resolveRepositoryRoot(cwd: string): string {
  const start = fs.realpathSync(cwd);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      timeout: 30_000,
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
  const raw = readIterativeGoalSettings(resolveRepositoryRoot(cwd)).trustedVerification;
  const config = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
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
  return sha256(JSON.stringify(config.checks));
}

export function trustedVerificationPolicyMatches(
  pinned: IterativeGoalState["trustedVerification"] | undefined,
  config: TrustedVerificationConfig,
): boolean {
  if (!pinned?.required) return true;
  return config.enabled && pinned.checksHash === trustedVerificationConfigHash(config);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
}

function trackedTreeClean(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "";
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

const SANDBOX_RECEIPTS: Record<TrustedVerificationSandboxBackend, TrustedVerificationSandboxReceipt> = {
  "macos-sandbox-exec": {
    backend: "macos-sandbox-exec",
    profile: "deny-default-v1",
    enforced: true,
    networkDenied: true,
    ambientCredentialsStripped: true,
    validationWorktreeWritable: true,
    sourceRepositoryReadDenied: true,
  },
  "linux-bwrap": {
    backend: "linux-bwrap",
    profile: "deny-default-v1",
    enforced: true,
    networkDenied: true,
    ambientCredentialsStripped: true,
    validationWorktreeWritable: true,
    sourceRepositoryReadDenied: true,
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
    "/usr/local/bin/" + name,
    "/opt/homebrew/bin/" + name,
    "/Library/Developer/CommandLineTools/usr/bin/" + name,
    "/usr/bin/" + name,
    "/bin/" + name,
    "/usr/sbin/" + name,
    "/sbin/" + name,
  ];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, name));
  }
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
    "(allow process*)",
    "(allow sysctl-read)",
    // V8 requires executable-memory/JIT permission even for a bounded `node
    // -e` capability probe. This does not grant filesystem, IPC, or network
    // access; those remain controlled by the explicit deny/allow rules.
    "(allow dynamic-code-generation)",
    // Node/libuv performs Mach service lookups during startup. This grants
    // IPC name resolution only; filesystem and network remain deny-default.
    "(allow mach-lookup)",
    `(allow file-read* ${readRules})`,
    `(allow file-read-metadata ${metadataRules})`,
    `(allow file-write* ${writeRules} (literal \"/dev/null\"))`,
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
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(path.delimiter);
}

function runSandboxedProcess(options: SandboxedProcessOptions): ReturnType<typeof spawnSync> {
  const resolvedExecutable = resolveExecutable(options.executable, options.cwd);
  const env = { ...options.env, PATH: sanitizedPath(resolvedExecutable, options.validationRoot) };
  if (options.selection.backend === "macos-sandbox-exec") {
    const profile = macSandboxProfile({
      validationRoot: options.validationRoot,
      cacheRoot: options.cacheRoot,
      executable: resolvedExecutable,
    });
    return spawnSync(options.selection.executable, ["-p", profile, resolvedExecutable, ...options.argv], {
      cwd: options.cwd,
      shell: false,
      encoding: "utf8",
      timeout: options.timeout,
      maxBuffer: 5 * 1024 * 1024,
      env,
    });
  }

  const readPaths = existingPaths([
    ...linuxSystemReadPaths(),
    ...executableReadPaths(resolvedExecutable, options.validationRoot),
  ]).filter((candidate) => !isWithinOrEqual(options.validationRoot, candidate)
    && !isWithinOrEqual(options.cacheRoot, candidate));
  const mountTargets = [...readPaths, options.validationRoot, options.cacheRoot];
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--tmpfs", "/"];
  for (const directory of mountParentDirectories(mountTargets)) args.push("--dir", directory);
  for (const candidate of readPaths) args.push("--ro-bind", candidate, candidate);
  args.push("--bind", options.validationRoot, options.validationRoot);
  args.push("--bind", options.cacheRoot, options.cacheRoot);
  args.push("--dir", "/dev", "--ro-bind", "/dev/null", "/dev/null", "--ro-bind", "/dev/zero", "/dev/zero");
  if (fs.existsSync("/dev/random")) args.push("--ro-bind", "/dev/random", "/dev/random");
  if (fs.existsSync("/dev/urandom")) args.push("--ro-bind", "/dev/urandom", "/dev/urandom");
  args.push("--proc", "/proc", "--tmpfs", "/tmp", "--clearenv");
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push("--setenv", key, value);
  }
  args.push("--chdir", options.cwd, resolvedExecutable, ...options.argv);
  return spawnSync(options.selection.executable, args, {
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 5 * 1024 * 1024,
    env: {},
  });
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
  try {
    fs.mkdirSync(validationRoot, { mode: 0o700 });
    fs.mkdirSync(cacheRoot, { mode: 0o700 });
    fs.writeFileSync(deniedRead, "sandbox-probe-secret", { mode: 0o600 });
    const probe = [
      "const fs=require('node:fs');",
      "let denied=0;",
      "try { fs.readFileSync(process.argv[1]); } catch { denied++; }",
      "try { fs.writeFileSync(process.argv[2], 'escape'); } catch { denied++; }",
      "fs.writeFileSync(process.argv[3], 'allowed');",
      "process.exit(denied === 2 ? 0 : 91);",
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
    const ok = outcome.status === 0
      && fs.existsSync(path.join(validationRoot, "allowed.txt"))
      && !fs.existsSync(deniedWrite);
    return {
      ok,
      reason: ok
        ? "capability probe passed"
        : `capability probe failed (${outcome.status === null ? outcome.error?.message ?? outcome.signal ?? "no exit status" : `exit ${outcome.status}`}): ${String(outcome.stderr || outcome.stdout || "no output").trim().slice(0, 500)}`,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
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

function validationEnvironment(sourceRoot: string, validationRoot: string): NodeJS.ProcessEnv {
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
  environment.NPM_CONFIG_CACHE = path.join(sourceRoot, ".pi", "iterative-goal", "managed", "verification-npm-cache");
  environment.NPM_CONFIG_USERCONFIG = path.join(validationRoot, ".verification-npmrc");
  environment.NPM_CONFIG_OFFLINE = "true";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  fs.mkdirSync(environment.TMPDIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(environment.HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(environment.NPM_CONFIG_CACHE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(environment.NPM_CONFIG_USERCONFIG, "", { mode: 0o600 });
  return environment;
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
  outcome: ReturnType<typeof spawnSync>;
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
    "",
    "STDOUT:",
    (params.outcome.stdout ?? "").slice(0, 2_000_000),
    "",
    "STDERR:",
    (params.outcome.stderr ?? params.outcome.error?.message ?? "").slice(0, 2_000_000),
  ].join("\n");
  fs.writeFileSync(params.artifact, artifactBytes, { mode: 0o600 });
  return {
    id: params.id,
    name: params.name,
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    artifact: params.artifact,
    startedAt: params.startedAt,
    endedAt,
    artifactSha256: sha256(artifactBytes),
    timedOut,
    signal: params.outcome.signal ?? null,
  };
}

function createDetachedValidationCheckout(sourceRoot: string, validationRoot: string, sourceSha: string): void {
  // A linked worktree stores its Git directory under the protected source
  // repository. Sandboxed `git` checks would then either fail or require a
  // dangerous source `.git` write exception. A shallow local fetch copies the
  // exact commit into a self-contained repository instead.
  fs.rmdirSync(validationRoot);
  execFileSync("git", ["init", "-q", validationRoot], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  execFileSync("git", ["fetch", "--quiet", "--no-tags", "--depth=1", sourceRoot, sourceSha], {
    cwd: validationRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  execFileSync("git", ["checkout", "--quiet", "--detach", sourceSha], {
    cwd: validationRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function removeValidationCheckout(validationRoot: string): void {
  // Removal is scoped to the freshly minted managed validation directory.
  fs.rmSync(validationRoot, { recursive: true, force: true });
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
  const artifactDir = params.stateManager.getPhaseDir(params.state.cycle, "validate");
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(artifactDir, "trusted-verification-receipt.json");
  // A new verifier attempt supersedes any older receipt for this cycle. If
  // this attempt crashes before signing, the prior PASS cannot survive it.
  try { fs.unlinkSync(receiptPath); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const sandboxSelection = selectTrustedVerificationSandbox();
  if (!sandboxSelection) {
    throw new Error("trusted verification requires an enforceable OS sandbox (macOS sandbox-exec or Linux bubblewrap); no backend passed the capability probe");
  }
  const sourceTrackedTreeCleanBefore = trackedTreeClean(sourceRoot);
  if (!sourceTrackedTreeCleanBefore) {
    throw new Error("trusted verification requires a clean tracked source tree at current HEAD");
  }
  const worktreeParent = path.join(sourceRoot, ".pi", "iterative-goal", "managed", "verification-worktrees");
  fs.mkdirSync(worktreeParent, { recursive: true, mode: 0o700 });
  const validationRoot = fs.mkdtempSync(path.join(worktreeParent, `c${params.state.cycle}-`));
  const results: TrustedVerificationResult[] = [];
  const resultsPath = path.join(artifactDir, "trusted-verification-results.jsonl");
  fs.writeFileSync(resultsPath, "", { mode: 0o600 });
  let validationSha = "";
  let validationShaAfter = "";
  let validationTrackedTreeClean = false;
  let dependencyBootstrap: TrustedVerificationResult | null = null;

  try {
    createDetachedValidationCheckout(sourceRoot, validationRoot, sourceSha);
    validationSha = git(validationRoot, ["rev-parse", "HEAD"]);
    const env = validationEnvironment(sourceRoot, validationRoot);

    const hasNpmLock = fs.existsSync(path.join(validationRoot, "package-lock.json"))
      || fs.existsSync(path.join(validationRoot, "npm-shrinkwrap.json"));
    if (hasNpmLock) {
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
        cacheRoot: env.NPM_CONFIG_CACHE!,
        env,
        timeout: 600_000,
      });
      dependencyBootstrap = writeProcessResult({
        id: "dependency-bootstrap",
        name: "Lockfile dependency bootstrap (lifecycle scripts disabled)",
        executable,
        argv,
        configuredCwd: ".",
        validationSha,
        artifact: path.join(artifactDir, "trusted-dependency-bootstrap.txt"),
        startedAt: bootstrapStartedAt,
        outcome,
      });
    }

    for (const check of config.checks) {
      const command = check.command;
      const artifact = path.join(artifactDir, `trusted-${check.id}.txt`);
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
        cacheRoot: env.NPM_CONFIG_CACHE!,
        env,
        timeout: command.timeoutMs ?? 120_000,
      }) : null;
      const timedOut = Boolean(outcome?.error && "code" in outcome.error && outcome.error.code === "ETIMEDOUT");
      const exitCode = outcome && typeof outcome.status === "number" ? outcome.status : null;
      const status: VerificationResult["status"] = command && exitCode === 0
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
        "",
        "STDOUT:",
        (outcome?.stdout ?? "").slice(0, 2_000_000),
        "",
        "STDERR:",
        (outcome?.stderr ?? outcome?.error?.message ?? "").slice(0, 2_000_000),
      ].join("\n");
      fs.writeFileSync(artifact, artifactBytes, { mode: 0o600 });
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
      };
      fs.appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
      results.push(result);
    }
    validationShaAfter = git(validationRoot, ["rev-parse", "HEAD"]);
    validationTrackedTreeClean = trackedTreeClean(validationRoot);
  } finally {
    removeValidationCheckout(validationRoot);
  }

  const sourceShaAfter = git(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceTrackedTreeCleanAfter = trackedTreeClean(sourceRoot);
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
    dependencyBootstrap,
    results,
    ok: (!dependencyBootstrap || dependencyBootstrap.status === "PASS")
      && !requiredFailed
      && sourceSha === sourceShaAfter
      && sourceSha === validationSha
      && validationSha === validationShaAfter
      && allTreesClean,
  };
  const receiptBytes = JSON.stringify(receipt, null, 2);
  fs.writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
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

export function readTrustedVerificationReceipt(cwd: string, state: IterativeGoalState, stateManager: StateManagerAPI): TrustedVerificationReceiptV1 | null {
  const receiptPath = stateManager.getArtifactPath(state.cycle, "validate", "trusted-verification-receipt.json");
  try {
    const repositoryRoot = resolveRepositoryRoot(cwd);
    const receiptBytes = fs.readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(receiptBytes) as TrustedVerificationReceiptV1;
    if (receipt.schema !== TRUSTED_VERIFICATION_SCHEMA || receipt.runId !== state.runId || receipt.cycle !== state.cycle) return null;
    if (!receipt.sandbox
      || !(["macos-sandbox-exec", "linux-bwrap"] as const).includes(receipt.sandbox.backend)
      || receipt.sandbox.profile !== "deny-default-v1"
      || receipt.sandbox.enforced !== true
      || receipt.sandbox.networkDenied !== true
      || receipt.sandbox.ambientCredentialsStripped !== true
      || receipt.sandbox.validationWorktreeWritable !== true
      || receipt.sandbox.sourceRepositoryReadDenied !== true) return null;
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
    const expectsDependencyBootstrap = fs.existsSync(path.join(repositoryRoot, "package-lock.json"))
      || fs.existsSync(path.join(repositoryRoot, "npm-shrinkwrap.json"));
    if (expectsDependencyBootstrap !== Boolean(receipt.dependencyBootstrap)) return null;
    if (receipt.dependencyBootstrap) {
      const bootstrapArtifact = fs.realpathSync(receipt.dependencyBootstrap.artifact);
      const bootstrapArtifactRoot = fs.realpathSync(stateManager.getPhaseDir(state.cycle, "validate"));
      if (!isWithin(bootstrapArtifactRoot, bootstrapArtifact)) return null;
      if (sha256(fs.readFileSync(bootstrapArtifact)) !== receipt.dependencyBootstrap.artifactSha256) return null;
    }
    const bootstrapPassed = !receipt.dependencyBootstrap || receipt.dependencyBootstrap.status === "PASS";
    const recomputedOk = bootstrapPassed && !requiredFailed
      && receipt.sourceSha === receipt.sourceShaAfter
      && receipt.sourceSha === receipt.validationSha
      && receipt.validationSha === receipt.validationShaAfter
      && receipt.trackedTreeClean;
    if (receipt.ok !== recomputedOk || !receipt.ok) return null;
    if (sha256(receipt.results.map((result) => JSON.stringify(result)).join("\n")) !== receipt.resultsHash) return null;
    const artifactRoot = fs.realpathSync(stateManager.getPhaseDir(state.cycle, "validate"));
    for (const result of receipt.results) {
      if (typeof result.artifact !== "string" || typeof result.artifactSha256 !== "string") return null;
      const artifact = fs.realpathSync(result.artifact);
      if (!isWithin(artifactRoot, artifact)) return null;
      if (sha256(fs.readFileSync(artifact)) !== result.artifactSha256) return null;
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
