#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  materializeTrustedNpmCache,
  trustedNpmMaterializationMatchesLock,
} from "../dist/trusted-dependencies.js";

function sha512Integrity(bytes) {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

function contentPath(cacheRoot, integrity) {
  const hex = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  return path.join(cacheRoot, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function writeCacheBlob(cacheRoot, integrity, bytes) {
  const destination = contentPath(cacheRoot, integrity);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return destination;
}

function createCacheRoot(scratch, name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { mode: 0o700 });
  return root;
}

function writeConsumer(root, packageName, version, resolved, integrity, duplicateWithoutIntegrity = false) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "trusted-dependency-consumer",
    version: "1.0.0",
    dependencies: { [packageName]: version },
  }, null, 2));
  const packages = {
    "": {
      name: "trusted-dependency-consumer",
      version: "1.0.0",
      dependencies: { [packageName]: version },
    },
    [`node_modules/${packageName}`]: { version, resolved, integrity },
  };
  if (duplicateWithoutIntegrity) {
    packages[`node_modules/duplicate/node_modules/${packageName}`] = { version, resolved };
  }
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    name: "trusted-dependency-consumer",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages,
  }, null, 2));
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-trusted-dependencies-")));
try {
  const packageName = "pi-ig-private-cache-fixture";
  const version = "1.0.0";
  const packageSource = path.join(scratch, "package-source");
  const lifecycleTrap = path.join(scratch, "lifecycle-trap.txt");
  const packCache = createCacheRoot(scratch, "pack-cache");
  const packed = path.join(scratch, "packed");
  fs.mkdirSync(packageSource);
  fs.mkdirSync(packed);
  fs.writeFileSync(path.join(packageSource, "package.json"), JSON.stringify({
    name: packageName,
    version,
    main: "index.js",
    scripts: { preinstall: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(lifecycleTrap)}, 'ran')`)}` },
  }, null, 2));
  fs.writeFileSync(path.join(packageSource, "index.js"), "export const fixture = true;\n");
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packed], {
    cwd: packageSource,
    env: {
      PATH: process.env.PATH,
      CI: "1",
      HOME: scratch,
      NPM_CONFIG_CACHE: packCache,
      NPM_CONFIG_USERCONFIG: path.join(scratch, "missing-npmrc"),
      NPM_CONFIG_OFFLINE: "true",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const tarballPath = path.join(packed, `${packageName}-${version}.tgz`);
  const tarballBytes = fs.readFileSync(tarballPath);
  const integrity = sha512Integrity(tarballBytes);
  const resolved = `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`;

  const consumer = path.join(scratch, "consumer");
  writeConsumer(consumer, packageName, version, resolved, integrity, true);

  // A symlink at the expected content-addressed path must be ignored. The
  // second cache supplies the same lock-addressed tarball as a regular file.
  const symlinkCache = createCacheRoot(scratch, "symlink-cache");
  const externalTrap = path.join(scratch, "external-cache-trap.tgz");
  fs.writeFileSync(externalTrap, Buffer.from("not the locked tarball"));
  const symlinkBlob = contentPath(symlinkCache, integrity);
  fs.mkdirSync(path.dirname(symlinkBlob), { recursive: true });
  fs.symlinkSync(externalTrap, symlinkBlob);
  const goodCache = createCacheRoot(scratch, "good-cache");
  writeCacheBlob(goodCache, integrity, tarballBytes);
  const privateCache = createCacheRoot(scratch, "private-cache");
  const receipt = materializeTrustedNpmCache({
    lockfilePath: path.join(consumer, "package-lock.json"),
    cacheRoot: privateCache,
    sourceRoot: consumer,
    ambientCacheRoots: [symlinkCache, goodCache],
    allowRegistryFetch: false,
  });
  assert.equal(receipt.status, "PASS", receipt.error ?? "materialization failed");
  assert.equal(receipt.uniqueTarballs, 1, "duplicate lock entries with one inherited integrity materialize once");
  assert.equal(receipt.verifiedCacheHits, 1);
  assert.equal(receipt.registryFetchAttempts, 0);
  assert.equal(receipt.verifiedRegistryFetches, 0);
  assert.equal(receipt.networkUsed, false);
  assert.equal(receipt.verifiedBytes, tarballBytes.length);
  assert.equal(JSON.stringify(receipt).includes("https://"), false, "signed materialization metadata contains no package URLs");
  assert.equal(fs.readFileSync(contentPath(privateCache, integrity)).equals(tarballBytes), true);
  assert.equal(
    trustedNpmMaterializationMatchesLock(receipt, path.join(consumer, "package-lock.json"), consumer),
    true,
    "receipt metrics and hashes bind to the exact lock manifest",
  );
  assert.equal(
    trustedNpmMaterializationMatchesLock({ ...receipt, manifestSha256: "0".repeat(64) }, path.join(consumer, "package-lock.json"), consumer),
    false,
    "manifest tampering is rejected",
  );
  assert.equal(
    trustedNpmMaterializationMatchesLock({ ...receipt, unexpectedUrl: resolved }, path.join(consumer, "package-lock.json"), consumer),
    false,
    "materialization receipts are a closed metadata-only shape",
  );

  const npmHome = path.join(consumer, ".npm-home");
  fs.mkdirSync(npmHome, { mode: 0o700 });
  const npmrc = path.join(consumer, ".npmrc-empty");
  fs.writeFileSync(npmrc, "");
  execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
    env: {
      PATH: process.env.PATH,
      CI: "1",
      HOME: npmHome,
      NPM_CONFIG_CACHE: privateCache,
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_OFFLINE: "true",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(fs.existsSync(path.join(consumer, "node_modules", packageName, "package.json")), true);
  assert.equal(fs.existsSync(lifecycleTrap), false, "offline npm ci must keep dependency lifecycle scripts disabled");

  const corruptCache = createCacheRoot(scratch, "corrupt-cache");
  writeCacheBlob(corruptCache, integrity, Buffer.from("malicious cache bytes"));
  const rejectedCache = createCacheRoot(scratch, "rejected-cache");
  const rejected = materializeTrustedNpmCache({
    lockfilePath: path.join(consumer, "package-lock.json"),
    cacheRoot: rejectedCache,
    sourceRoot: consumer,
    ambientCacheRoots: [corruptCache],
    allowRegistryFetch: false,
  });
  assert.equal(rejected.status, "FAIL");
  assert.match(rejected.error ?? "", /authenticated tarball is unavailable/);
  assert.equal(rejected.verifiedBytes, 0);
  assert.deepEqual(fs.readdirSync(rejectedCache), [], "unverified cache bytes are never published");

  const sourceOwnedCache = path.join(consumer, ".source-owned-cache");
  fs.mkdirSync(sourceOwnedCache, { mode: 0o700 });
  writeCacheBlob(sourceOwnedCache, integrity, tarballBytes);
  const sourceOwnedTarget = createCacheRoot(scratch, "source-owned-target");
  const sourceOwned = materializeTrustedNpmCache({
    lockfilePath: path.join(consumer, "package-lock.json"),
    cacheRoot: sourceOwnedTarget,
    sourceRoot: consumer,
    ambientCacheRoots: [sourceOwnedCache],
    allowRegistryFetch: false,
  });
  assert.equal(sourceOwned.status, "FAIL");
  assert.equal(sourceOwned.verifiedCacheHits, 0, "a source-controlled cache is never considered an authenticated source");
  assert.deepEqual(fs.readdirSync(sourceOwnedTarget), []);

  const oversizedCache = createCacheRoot(scratch, "oversized-cache");
  const oversizedBlob = contentPath(oversizedCache, integrity);
  fs.mkdirSync(path.dirname(oversizedBlob), { recursive: true });
  fs.closeSync(fs.openSync(oversizedBlob, "w"));
  fs.truncateSync(oversizedBlob, (128 * 1024 * 1024) + 1);
  const oversizedTarget = createCacheRoot(scratch, "oversized-target");
  const oversized = materializeTrustedNpmCache({
    lockfilePath: path.join(consumer, "package-lock.json"),
    cacheRoot: oversizedTarget,
    sourceRoot: consumer,
    ambientCacheRoots: [oversizedCache],
    allowRegistryFetch: false,
  });
  assert.equal(oversized.status, "FAIL");
  assert.equal(oversized.verifiedBytes, 0, "an oversized tarball is rejected before reading or publication");
  assert.deepEqual(fs.readdirSync(oversizedTarget), []);

  const badOriginConsumer = path.join(scratch, "bad-origin-consumer");
  writeConsumer(badOriginConsumer, packageName, version, `https://example.invalid/${packageName}.tgz`, integrity);
  const badOriginCache = createCacheRoot(scratch, "bad-origin-cache");
  const badOrigin = materializeTrustedNpmCache({
    lockfilePath: path.join(badOriginConsumer, "package-lock.json"),
    cacheRoot: badOriginCache,
    sourceRoot: badOriginConsumer,
    ambientCacheRoots: [goodCache],
  });
  assert.equal(badOrigin.status, "FAIL");
  assert.match(badOrigin.error ?? "", /outside the trusted npm registry policy/);
  assert.equal(badOrigin.networkUsed, false, "disallowed origins fail before any network attempt");
  assert.equal(JSON.stringify(badOrigin).includes("https://"), false, "failure metadata does not echo an untrusted URL");

  const deadlineCache = createCacheRoot(scratch, "deadline-cache");
  const deadlineReceipt = materializeTrustedNpmCache({
    lockfilePath: path.join(consumer, "package-lock.json"),
    cacheRoot: deadlineCache,
    sourceRoot: consumer,
    ambientCacheRoots: [goodCache],
    allowRegistryFetch: false,
    maximumDurationMs: 0,
  });
  assert.equal(deadlineReceipt.status, "FAIL");
  assert.match(deadlineReceipt.error ?? "", /total deadline/);
  assert.equal(deadlineReceipt.verifiedBytes, 0);
  assert.deepEqual(fs.readdirSync(deadlineCache), [], "an expired total deadline publishes no package bytes");

  const symlinkedPrivateCache = path.join(scratch, "private-cache-symlink");
  const symlinkTarget = createCacheRoot(scratch, "private-cache-target");
  fs.symlinkSync(symlinkTarget, symlinkedPrivateCache);
  const symlinked = materializeTrustedNpmCache({
    lockfilePath: path.join(consumer, "package-lock.json"),
    cacheRoot: symlinkedPrivateCache,
    sourceRoot: consumer,
    ambientCacheRoots: [goodCache],
    allowRegistryFetch: false,
  });
  assert.equal(symlinked.status, "FAIL");
  assert.match(symlinked.error ?? "", /real directory/);
  assert.deepEqual(fs.readdirSync(symlinkTarget), []);

  const lockSymlink = path.join(consumer, "package-lock-symlink.json");
  fs.symlinkSync(path.join(consumer, "package-lock.json"), lockSymlink);
  const lockSymlinkCache = createCacheRoot(scratch, "lock-symlink-cache");
  const lockSymlinkReceipt = materializeTrustedNpmCache({
    lockfilePath: lockSymlink,
    cacheRoot: lockSymlinkCache,
    sourceRoot: consumer,
    ambientCacheRoots: [goodCache],
    allowRegistryFetch: false,
  });
  assert.equal(lockSymlinkReceipt.status, "FAIL");
  assert.equal(lockSymlinkReceipt.lockfileSha256, "");

  const outsideLockCache = createCacheRoot(scratch, "outside-lock-cache");
  const outsideLock = path.join(scratch, "outside-package-lock.json");
  fs.copyFileSync(path.join(consumer, "package-lock.json"), outsideLock);
  const outsideLockReceipt = materializeTrustedNpmCache({
    lockfilePath: outsideLock,
    cacheRoot: outsideLockCache,
    sourceRoot: consumer,
    ambientCacheRoots: [goodCache],
    allowRegistryFetch: false,
  });
  assert.equal(outsideLockReceipt.status, "FAIL");
  assert.match(outsideLockReceipt.error ?? "", /inside the source repository/);
  assert.equal(outsideLockReceipt.lockfileSha256, "", "an out-of-root lockfile is rejected before reading");

  console.log("trusted-dependencies: PASS (lock-integrity private cache, offline ci, no-follow, fail-closed origins/corruption)");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
