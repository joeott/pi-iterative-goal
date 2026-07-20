import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TRUSTED_NPM_MATERIALIZATION_SCHEMA = "pi-iterative-goal.trusted-npm-materialization.v1" as const;

const TRUSTED_NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const TRUSTED_NPM_REGISTRY_POLICY = "npmjs-https-no-redirect-v1" as const;
const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TARBALLS = 10_000;
const MAX_MATERIALIZATION_MS = 10 * 60 * 1_000;

export interface TrustedNpmMaterializationReceipt {
  schema: typeof TRUSTED_NPM_MATERIALIZATION_SCHEMA;
  status: "PASS" | "FAIL";
  lockfileSha256: string;
  manifestSha256: string;
  registryPolicy: typeof TRUSTED_NPM_REGISTRY_POLICY;
  uniqueTarballs: number;
  verifiedCacheHits: number;
  registryFetchAttempts: number;
  verifiedRegistryFetches: number;
  verifiedBytes: number;
  networkUsed: boolean;
  durationMs: number;
  error: string | null;
}

export interface TrustedNpmMaterializationOptions {
  lockfilePath: string;
  cacheRoot: string;
  sourceRoot: string;
  /** Injectable only for deterministic tests. Every byte remains digest-checked. */
  ambientCacheRoots?: string[];
  /** Production defaults to true; tests can prove cache-only behavior. */
  allowRegistryFetch?: boolean;
  /** May only tighten the production deadline. Zero is useful for fail-closed tests. */
  maximumDurationMs?: number;
}

export interface TrustedNpmLockMetadata {
  lockfileSha256: string;
  manifestSha256: string;
  uniqueTarballs: number;
}

interface LockedTarball {
  resolved: string;
  integrity: string;
  digest: Buffer;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pathError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readRegularFileNoFollow(filePath: string, maximumBytes: number): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
    if (stat.size > maximumBytes) throw new Error(`file exceeds ${maximumBytes} bytes: ${filePath}`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateCacheRoot(sourceRoot: string, cacheRoot: string): string {
  const canonicalSource = fs.realpathSync(sourceRoot);
  const suppliedCache = path.resolve(cacheRoot);
  const suppliedStat = fs.lstatSync(suppliedCache);
  if (!suppliedStat.isDirectory() || suppliedStat.isSymbolicLink()) {
    throw new Error("trusted npm cache root must be a real directory");
  }
  const canonicalCache = fs.realpathSync(suppliedCache);
  if (canonicalCache !== suppliedCache) {
    throw new Error("trusted npm cache root must have a canonical, symlink-free path");
  }
  const stat = fs.lstatSync(canonicalCache);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("trusted npm cache root must be a real directory");
  }
  fs.chmodSync(canonicalCache, 0o700);
  if ((fs.statSync(canonicalCache).mode & 0o077) !== 0) {
    throw new Error("trusted npm cache root permissions are too broad");
  }
  if (isWithinOrEqual(canonicalSource, canonicalCache)) {
    throw new Error("trusted npm cache root must be outside the source repository");
  }
  if (fs.readdirSync(canonicalCache).length !== 0) {
    throw new Error("trusted npm cache root must start empty");
  }
  return canonicalCache;
}

function parseSha512Integrity(integrity: unknown): Buffer | null {
  if (typeof integrity !== "string") return null;
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity);
  if (!match) return null;
  const digest = Buffer.from(match[1], "base64");
  return digest.length === 64 && `sha512-${digest.toString("base64")}` === integrity ? digest : null;
}

function assertRegistryTarballUrl(resolved: string): void {
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error("lockfile resolved URL is invalid");
  }
  if (parsed.origin !== TRUSTED_NPM_REGISTRY_ORIGIN
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !parsed.pathname.endsWith(".tgz")) {
    throw new Error("lockfile tarball is outside the trusted npm registry policy");
  }
}

function lockedTarballs(lockfileBytes: Buffer): LockedTarball[] {
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(lockfileBytes.toString("utf8"));
  } catch {
    throw new Error("package lock is not valid JSON");
  }
  if (!lockfile || typeof lockfile !== "object") throw new Error("package lock must be an object");
  const record = lockfile as Record<string, unknown>;
  if (!(record.lockfileVersion === 2 || record.lockfileVersion === 3)) {
    throw new Error("trusted npm materialization requires lockfileVersion 2 or 3");
  }
  if (!record.packages || typeof record.packages !== "object" || Array.isArray(record.packages)) {
    throw new Error("package lock is missing its packages map");
  }

  const entries = Object.values(record.packages as Record<string, unknown>)
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
  const knownIntegrity = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.resolved !== "string" || typeof entry.integrity !== "string") continue;
    const prior = knownIntegrity.get(entry.resolved);
    if (prior && prior !== entry.integrity) {
      throw new Error("lockfile assigns conflicting integrities to one resolved tarball");
    }
    knownIntegrity.set(entry.resolved, entry.integrity);
  }

  const unique = new Map<string, LockedTarball>();
  for (const entry of entries) {
    if (entry.link === true || entry.resolved === undefined) continue;
    if (typeof entry.resolved !== "string") throw new Error("lockfile resolved value must be a string");
    assertRegistryTarballUrl(entry.resolved);
    const integrity = typeof entry.integrity === "string" ? entry.integrity : knownIntegrity.get(entry.resolved);
    const digest = parseSha512Integrity(integrity);
    if (!integrity || !digest) {
      throw new Error("lockfile tarball lacks one canonical SHA-512 integrity");
    }
    const prior = unique.get(entry.resolved);
    if (prior && prior.integrity !== integrity) {
      throw new Error("lockfile assigns conflicting integrities to one resolved tarball");
    }
    unique.set(entry.resolved, { resolved: entry.resolved, integrity, digest });
  }
  if (unique.size > MAX_TARBALLS) throw new Error(`package lock exceeds ${MAX_TARBALLS} unique tarballs`);
  return [...unique.values()].sort((left, right) => left.resolved.localeCompare(right.resolved));
}

function loadTrustedNpmLock(lockfilePath: string, sourceRoot: string): {
  metadata: TrustedNpmLockMetadata;
  tarballs: LockedTarball[];
} {
  const canonicalSource = fs.realpathSync(sourceRoot);
  const absoluteLockfile = path.resolve(lockfilePath);
  const canonicalLockfile = fs.realpathSync(absoluteLockfile);
  if (!isWithinOrEqual(canonicalSource, canonicalLockfile) || canonicalLockfile !== absoluteLockfile) {
    throw new Error("trusted npm lockfile must be a canonical file inside the source repository");
  }
  const lockfileBytes = readRegularFileNoFollow(canonicalLockfile, MAX_LOCKFILE_BYTES);
  const tarballs = lockedTarballs(lockfileBytes);
  return {
    metadata: {
      lockfileSha256: sha256(lockfileBytes),
      manifestSha256: sha256(tarballs.map((item) => `${item.resolved}\0${item.integrity}`).join("\n")),
      uniqueTarballs: tarballs.length,
    },
    tarballs,
  };
}

export function inspectTrustedNpmLock(lockfilePath: string, sourceRoot: string): TrustedNpmLockMetadata {
  return loadTrustedNpmLock(lockfilePath, sourceRoot).metadata;
}

export function trustedNpmMaterializationMatchesLock(
  value: unknown,
  lockfilePath: string,
  sourceRoot: string,
): value is TrustedNpmMaterializationReceipt {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const receipt = value as Record<string, unknown>;
    const expectedKeys = [
      "durationMs",
      "error",
      "lockfileSha256",
      "manifestSha256",
      "networkUsed",
      "registryFetchAttempts",
      "registryPolicy",
      "schema",
      "status",
      "uniqueTarballs",
      "verifiedBytes",
      "verifiedCacheHits",
      "verifiedRegistryFetches",
    ];
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)) return false;
    if (receipt.schema !== TRUSTED_NPM_MATERIALIZATION_SCHEMA
      || receipt.status !== "PASS"
      || receipt.registryPolicy !== TRUSTED_NPM_REGISTRY_POLICY
      || receipt.error !== null) return false;
    const integers = [
      receipt.uniqueTarballs,
      receipt.verifiedCacheHits,
      receipt.registryFetchAttempts,
      receipt.verifiedRegistryFetches,
      receipt.verifiedBytes,
      receipt.durationMs,
    ];
    if (!integers.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) return false;
    if ((receipt.verifiedBytes as number) > MAX_TOTAL_BYTES || (receipt.durationMs as number) > MAX_MATERIALIZATION_MS) return false;
    if ((receipt.verifiedCacheHits as number) + (receipt.verifiedRegistryFetches as number) !== receipt.uniqueTarballs) return false;
    if (receipt.registryFetchAttempts !== receipt.verifiedRegistryFetches) return false;
    if (receipt.networkUsed !== ((receipt.registryFetchAttempts as number) > 0)) return false;
    const metadata = inspectTrustedNpmLock(lockfilePath, sourceRoot);
    return receipt.lockfileSha256 === metadata.lockfileSha256
      && receipt.manifestSha256 === metadata.manifestSha256
      && receipt.uniqueTarballs === metadata.uniqueTarballs;
  } catch {
    return false;
  }
}

function cacacheContentPath(cacheRoot: string, digest: Buffer): string {
  const hex = digest.toString("hex");
  return path.join(cacheRoot, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function cacacheIndexPath(cacheRoot: string, resolved: string): string {
  const key = `make-fetch-happen:request-cache:${resolved}`;
  const digest = sha256(key);
  return path.join(cacheRoot, "_cacache", "index-v5", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
}

function writeExclusiveNoFollow(filePath: string, bytes: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  let complete = false;
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    complete = true;
  } finally {
    fs.closeSync(descriptor);
    if (!complete) {
      try { fs.unlinkSync(filePath); } catch { /* retain the original write failure */ }
    }
  }
}

function verifiedAmbientBytes(cacheRoots: string[], tarball: LockedTarball): Buffer | null {
  for (const root of cacheRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    const candidate = cacacheContentPath(canonicalRoot, tarball.digest);
    try {
      const bytes = readRegularFileNoFollow(candidate, MAX_TARBALL_BYTES);
      const actual = crypto.createHash("sha512").update(bytes).digest();
      if (crypto.timingSafeEqual(actual, tarball.digest)) return bytes;
    } catch {
      // An untrusted cache miss, symlink, non-file, oversize blob, or digest
      // mismatch is never fatal while another authenticated source remains.
    }
  }
  return null;
}

const REGISTRY_FETCH_HELPER = String.raw`
const fs = require("node:fs");
const https = require("node:https");
const [url, output, maximumText] = process.argv.slice(1);
const maximum = Number(maximumText);
let descriptor;
try { descriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
catch (error) { console.error(error.message); process.exit(70); }
let settled = false;
function finish(code, message) {
  if (settled) return;
  settled = true;
  try { fs.closeSync(descriptor); } catch {}
  if (code !== 0) try { fs.unlinkSync(output); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
const request = https.get(url, {
  headers: { "accept": "application/octet-stream", "accept-encoding": "identity", "user-agent": "pi-iterative-goal-lock-materializer/1" },
  rejectUnauthorized: true,
}, (response) => {
  if (response.statusCode !== 200) {
    response.resume();
    finish(71, "registry returned HTTP " + response.statusCode);
    return;
  }
  let total = 0;
  response.on("data", (chunk) => {
    total += chunk.length;
    if (total > maximum) {
      request.destroy(new Error("registry tarball exceeds byte limit"));
      return;
    }
    fs.writeSync(descriptor, chunk);
  });
  response.once("end", () => {
    try { fs.fsyncSync(descriptor); } catch (error) { finish(72, error.message); return; }
    finish(0, "");
  });
  response.once("error", (error) => finish(73, error.message));
});
request.setTimeout(30_000, () => request.destroy(new Error("registry request timed out")));
request.once("error", (error) => finish(74, error.message));
`;

function fetchRegistryBytes(cacheRoot: string, tarball: LockedTarball, remainingMs: number): Buffer {
  const temporaryPath = path.join(cacheRoot, `.registry-${crypto.randomBytes(16).toString("hex")}.tgz`);
  const outcome = spawnSync(process.execPath, ["-e", REGISTRY_FETCH_HELPER, tarball.resolved, temporaryPath, String(MAX_TARBALL_BYTES)], {
    cwd: cacheRoot,
    env: { CI: "1", HOME: cacheRoot, NO_PROXY: "*", no_proxy: "*", NODE_OPTIONS: "" },
    shell: false,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(45_000, remainingMs)),
    maxBuffer: 64 * 1024,
  });
  try {
    if (outcome.status !== 0) {
      throw new Error(`registry fetch failed: ${String(outcome.stderr || outcome.error?.message || `exit ${outcome.status}`).trim().slice(0, 500)}`);
    }
    const bytes = readRegularFileNoFollow(temporaryPath, MAX_TARBALL_BYTES);
    const actual = crypto.createHash("sha512").update(bytes).digest();
    if (!crypto.timingSafeEqual(actual, tarball.digest)) {
      throw new Error("registry bytes failed lockfile integrity");
    }
    return bytes;
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (!pathError(error, "ENOENT")) throw error;
    }
  }
}

function writeIndexEntry(cacheRoot: string, tarball: LockedTarball, size: number): void {
  const key = `make-fetch-happen:request-cache:${tarball.resolved}`;
  const now = Date.now();
  const entry = JSON.stringify({
    key,
    integrity: tarball.integrity,
    time: now,
    size,
    metadata: {
      time: now,
      url: tarball.resolved,
      reqHeaders: {},
      resHeaders: { "content-type": "application/octet-stream" },
      options: { compress: true },
    },
  });
  const line = `\n${crypto.createHash("sha1").update(entry).digest("hex")}\t${entry}`;
  writeExclusiveNoFollow(cacacheIndexPath(cacheRoot, tarball.resolved), line);
}

function defaultAmbientCacheRoots(): string[] {
  const roots = [process.env.NPM_CONFIG_CACHE, path.join(os.homedir(), ".npm")]
    .filter((candidate): candidate is string => Boolean(candidate && path.isAbsolute(candidate)));
  return [...new Set(roots)];
}

export function materializeTrustedNpmCache(options: TrustedNpmMaterializationOptions): TrustedNpmMaterializationReceipt {
  const startedAt = Date.now();
  const configuredDuration = options.maximumDurationMs ?? MAX_MATERIALIZATION_MS;
  const maximumDurationMs = Number.isSafeInteger(configuredDuration) && configuredDuration >= 0
    ? Math.min(configuredDuration, MAX_MATERIALIZATION_MS)
    : -1;
  const deadline = startedAt + maximumDurationMs;
  let lockfileSha256 = "";
  let manifestSha256 = "";
  let uniqueTarballs = 0;
  let verifiedCacheHits = 0;
  let registryFetchAttempts = 0;
  let verifiedRegistryFetches = 0;
  let verifiedBytes = 0;
  let networkAttempted = false;
  try {
    if (maximumDurationMs < 0) throw new Error("trusted npm materialization deadline is invalid");
    const canonicalSource = fs.realpathSync(options.sourceRoot);
    const cacheRoot = assertPrivateCacheRoot(options.sourceRoot, options.cacheRoot);
    const loadedLock = loadTrustedNpmLock(options.lockfilePath, options.sourceRoot);
    const tarballs = loadedLock.tarballs;
    ({ lockfileSha256, manifestSha256, uniqueTarballs } = loadedLock.metadata);
    const ambientRoots = (options.ambientCacheRoots ?? defaultAmbientCacheRoots()).flatMap((candidate) => {
      try {
        const canonical = fs.realpathSync(candidate);
        return isWithinOrEqual(canonicalSource, canonical) || canonical === cacheRoot ? [] : [canonical];
      } catch {
        return [];
      }
    });

    for (const tarball of tarballs) {
      if (Date.now() >= deadline) throw new Error("trusted npm materialization exceeded its total deadline");
      let bytes = verifiedAmbientBytes(ambientRoots, tarball);
      if (bytes) {
        verifiedCacheHits += 1;
      } else {
        if (options.allowRegistryFetch === false) {
          throw new Error("an authenticated tarball is unavailable in the supplied caches");
        }
        networkAttempted = true;
        registryFetchAttempts += 1;
        bytes = fetchRegistryBytes(cacheRoot, tarball, deadline - Date.now());
        verifiedRegistryFetches += 1;
      }
      if (Date.now() > deadline) throw new Error("trusted npm materialization exceeded its total deadline");
      verifiedBytes += bytes.length;
      if (verifiedBytes > MAX_TOTAL_BYTES) throw new Error(`verified dependency bytes exceed ${MAX_TOTAL_BYTES}`);
      writeExclusiveNoFollow(cacacheContentPath(cacheRoot, tarball.digest), bytes);
      writeIndexEntry(cacheRoot, tarball, bytes.length);
    }
    if (Date.now() > deadline) throw new Error("trusted npm materialization exceeded its total deadline");

    return {
      schema: TRUSTED_NPM_MATERIALIZATION_SCHEMA,
      status: "PASS",
      lockfileSha256,
      manifestSha256,
      registryPolicy: TRUSTED_NPM_REGISTRY_POLICY,
      uniqueTarballs,
      verifiedCacheHits,
      registryFetchAttempts,
      verifiedRegistryFetches,
      verifiedBytes,
      networkUsed: networkAttempted,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      schema: TRUSTED_NPM_MATERIALIZATION_SCHEMA,
      status: "FAIL",
      lockfileSha256,
      manifestSha256,
      registryPolicy: TRUSTED_NPM_REGISTRY_POLICY,
      uniqueTarballs,
      verifiedCacheHits,
      registryFetchAttempts,
      verifiedRegistryFetches,
      verifiedBytes,
      networkUsed: networkAttempted,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
