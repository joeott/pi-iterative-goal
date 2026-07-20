import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GIT_CANDIDATES = ["/usr/bin/git", "/bin/git"];
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_BUILD_FILES = 10_000;
const MAX_BUILD_BYTES = 512 * 1024 * 1024;

function resolveSystemGit() {
  for (const candidate of GIT_CANDIDATES) {
    try {
      const canonical = fs.realpathSync(candidate);
      const stat = fs.statSync(canonical);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return canonical;
    } catch { /* try the next immutable system location */ }
  }
  throw new Error("trusted system git executable is unavailable");
}

export const SYSTEM_GIT = resolveSystemGit();

export function sanitizedRuntimePath(repoRoot) {
  return [...new Set([
    path.dirname(fs.realpathSync(process.execPath)),
    path.join(fs.realpathSync(repoRoot), "node_modules", ".bin"),
    "/usr/bin",
    "/bin",
  ])].join(":");
}

export function sanitizedGitEnvironment(extra = {}) {
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

export function runGit(cwd, args, options = {}) {
  const allowedStatuses = options.allowedStatuses ?? [0];
  const result = spawnSync(SYSTEM_GIT, [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], {
    cwd: fs.realpathSync(cwd),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBufferBytes ?? MAX_GIT_OUTPUT_BYTES,
    env: sanitizedGitEnvironment(options.env),
    input: options.input,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`git ${args.join(" ")} failed with status ${result.status}: ${String(result.stderr ?? "").trim().slice(0, 1000)}`);
  }
  return result;
}

export function gitOutput(cwd, args, options = {}) {
  return runGit(cwd, args, options).stdout.trim();
}

export function assertCleanTrackedHead(cwd) {
  const root = fs.realpathSync(cwd);
  const untrackedBuildInputs = gitOutput(root, [
    "ls-files", "--others", "--exclude-standard", "--",
    "src", "scripts", "config", "package.json", "package-lock.json", "tsconfig.json",
  ]);
  if (untrackedBuildInputs) {
    throw new Error(`untracked production/build inputs are not bound to HEAD: ${untrackedBuildInputs.split(/\r?\n/).slice(0, 20).join(", ")}`);
  }
  const tags = gitOutput(root, ["ls-files", "-v", "--"]);
  if (tags.split(/\r?\n/).filter(Boolean).some((line) => /^[a-zS]/.test(line))) {
    throw new Error("tracked source uses assume-unchanged or skip-worktree metadata");
  }
  const staged = runGit(root, ["diff-index", "--cached", "--quiet", "HEAD", "--"], { allowedStatuses: [0, 1], stdio: "ignore" });
  if (staged.status !== 0) throw new Error("tracked index differs from HEAD");

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-prod-index-"));
  try {
    fs.chmodSync(scratch, 0o700);
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    runGit(root, ["read-tree", "HEAD"], { env, stdio: "ignore" });
    const refresh = runGit(root, ["update-index", "--really-refresh", "--ignore-submodules"], {
      env,
      allowedStatuses: [0, 1],
      stdio: "ignore",
    });
    if (refresh.status !== 0) throw new Error("tracked worktree differs from HEAD");
    const worktree = runGit(root, ["diff-files", "--quiet", "--ignore-submodules=none", "--"], {
      env,
      allowedStatuses: [0, 1],
      stdio: "ignore",
    });
    if (worktree.status !== 0) throw new Error("tracked worktree differs from HEAD");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function boundedFileIdentity(filePath, maximumBytes = MAX_RUNTIME_FILE_BYTES) {
  const canonicalPath = fs.realpathSync(filePath);
  const descriptor = fs.openSync(canonicalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error(`runtime input is not a bounded regular file: ${canonicalPath}`);
    }
    const digest = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error(`runtime input grew beyond ${maximumBytes} bytes: ${canonicalPath}`);
      digest.update(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || total !== before.size) {
      throw new Error(`runtime input changed while hashing: ${canonicalPath}`);
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

function collectTreeFiles(root, directory = root, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`build tree contains a symlink: ${candidate}`);
    if (stat.isDirectory()) collectTreeFiles(root, candidate, output);
    else if (stat.isFile()) output.push(path.relative(root, candidate).replace(/\\/g, "/"));
    else throw new Error(`build tree contains a non-regular entry: ${candidate}`);
    if (output.length > MAX_BUILD_FILES) throw new Error(`build tree exceeds ${MAX_BUILD_FILES} files`);
  }
  return output;
}

export function treeIdentity(root, expectedFiles = null) {
  const canonicalRoot = fs.realpathSync(root);
  const files = expectedFiles ?? collectTreeFiles(canonicalRoot);
  const digest = crypto.createHash("sha256");
  let totalBytes = 0;
  for (const relative of files) {
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split("/").includes("..")) {
      throw new Error(`invalid build-tree path: ${String(relative)}`);
    }
    const identity = boundedFileIdentity(path.join(canonicalRoot, relative), MAX_BUILD_BYTES);
    totalBytes += identity.size;
    if (totalBytes > MAX_BUILD_BYTES) throw new Error(`build tree exceeds ${MAX_BUILD_BYTES} bytes`);
    digest.update(relative).update("\0").update(String(identity.size)).update("\0").update(identity.sha256).update("\n");
  }
  return { sha256: digest.digest("hex"), files: files.length, totalBytes, relativeFiles: [...files] };
}

export function verifyFreshTrackedBuild(repoRoot) {
  const canonicalRoot = fs.realpathSync(repoRoot);
  assertCleanTrackedHead(canonicalRoot);
  const tscPath = path.join(canonicalRoot, "node_modules", "typescript", "bin", "tsc");
  const tscIdentity = boundedFileIdentity(tscPath, 32 * 1024 * 1024);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-prod-build-"));
  try {
    fs.chmodSync(scratch, 0o700);
    const outputRoot = path.join(scratch, "dist");
    const result = spawnSync(process.execPath, [tscIdentity.path, "--outDir", outputRoot], {
      cwd: canonicalRoot,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: sanitizedRuntimePath(canonicalRoot),
        HOME: scratch,
        TMPDIR: scratch,
        LC_ALL: "C",
        NO_COLOR: "1",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`fresh tracked TypeScript build failed: ${String(result.stderr).slice(-2000)}`);
    const expected = treeIdentity(outputRoot);
    const observed = treeIdentity(path.join(canonicalRoot, "dist"), expected.relativeFiles);
    if (expected.sha256 !== observed.sha256 || expected.files !== observed.files || expected.totalBytes !== observed.totalBytes) {
      throw new Error("dist does not match a fresh compilation of the clean tracked source");
    }
    return {
      status: "PASS",
      expectedSha256: expected.sha256,
      expectedFiles: expected.files,
      expectedBytes: expected.totalBytes,
      compiler: { path: tscIdentity.path, sha256: tscIdentity.sha256, size: tscIdentity.size },
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function publicIdentity(identity) {
  return { path: identity.path, sha256: identity.sha256, size: identity.size };
}

export function captureRuntimeProvenance(repoRoot, { extensionPath, piPath }) {
  const canonicalRoot = fs.realpathSync(repoRoot);
  assertCleanTrackedHead(canonicalRoot);
  const build = verifyFreshTrackedBuild(canonicalRoot);
  const harnessPaths = [
    "scripts/prod-runtime-confirmation.mjs",
    "scripts/prod-feature-matrix.mjs",
    "scripts/lib/bounded-tree-snapshot.mjs",
    "scripts/lib/prod-feature-matrix.mjs",
    "scripts/lib/runtime-provenance.mjs",
  ];
  const harnessBlobs = {};
  for (const relative of harnessPaths) {
    runGit(canonicalRoot, ["ls-files", "--error-unmatch", "--", relative], { stdio: "ignore" });
    const committed = gitOutput(canonicalRoot, ["rev-parse", `HEAD:${relative}`]);
    const observed = gitOutput(canonicalRoot, ["hash-object", "--", relative]);
    if (committed !== observed) throw new Error(`production harness differs from HEAD: ${relative}`);
    harnessBlobs[relative] = committed;
  }
  return {
    schema: "pi-iterative-goal.runtime-provenance.v1",
    headSha: gitOutput(canonicalRoot, ["rev-parse", "HEAD"]),
    treeSha: gitOutput(canonicalRoot, ["rev-parse", "HEAD^{tree}"]),
    packageLockSha256: boundedFileIdentity(path.join(canonicalRoot, "package-lock.json"), 16 * 1024 * 1024).sha256,
    node: publicIdentity(boundedFileIdentity(process.execPath)),
    pi: publicIdentity(boundedFileIdentity(piPath, 128 * 1024 * 1024)),
    extension: publicIdentity(boundedFileIdentity(extensionPath, 64 * 1024 * 1024)),
    build,
    harnessBlobs,
  };
}

export function assertRuntimeProvenanceUnchanged(repoRoot, provenance) {
  const current = captureRuntimeProvenance(repoRoot, {
    extensionPath: provenance.extension.path,
    piPath: provenance.pi.path,
  });
  if (JSON.stringify(current) !== JSON.stringify(provenance)) {
    throw new Error("runtime provenance changed during production confirmation");
  }
  return current;
}
