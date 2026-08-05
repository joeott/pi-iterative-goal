import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_TREE_SNAPSHOT_ENTRIES = 100_000;
export const MAX_TREE_SNAPSHOT_BYTES = 10 * 1024 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

function assertPositiveBound(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/** Hash every byte of one stable, regular, non-symlink file. */
function sha256RegularFile(filePath, expectedStat, maximumBytes) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is unavailable; snapshot file reads cannot be trusted");
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 0 || before.size > maximumBytes) {
      throw new Error(`snapshot file is not a bounded regular file: ${filePath}`);
    }
    if (!sameFileIdentity(expectedStat, before)) {
      throw new Error(`snapshot file changed before hashing: ${filePath}`);
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, before.size)));
    let bytesHashed = 0;
    while (bytesHashed < before.size) {
      const wanted = Math.min(buffer.length, before.size - bytesHashed);
      const count = fs.readSync(descriptor, buffer, 0, wanted, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytesHashed += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    const overflowBytes = fs.readSync(descriptor, overflow, 0, 1, null);
    const after = fs.fstatSync(descriptor);
    if (bytesHashed !== before.size || overflowBytes !== 0 || !sameFileIdentity(before, after)) {
      throw new Error(`snapshot file changed while hashing: ${filePath}`);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function listRecursive(dir, base, bounds, limits) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      bounds.entries += 1;
      found.push(path.relative(base, filePath));
    } else if (stat.isDirectory()) {
      bounds.entries += 1;
      found.push(`${path.relative(base, filePath)}${path.sep}`);
      found.push(...listRecursive(filePath, base, bounds, limits));
    } else if (stat.isFile()) {
      bounds.entries += 1;
      bounds.fileBytes += stat.size;
      found.push(path.relative(base, filePath));
    } else {
      throw new Error(`snapshot tree contains an unsupported entry type: ${filePath}`);
    }
    if (bounds.entries > limits.maxEntries || bounds.fileBytes > limits.maxBytes) {
      throw new Error("snapshot tree exceeds the bounded entry/byte census");
    }
  }
  return found;
}

/**
 * Capture a bounded tree identity. Every regular-file byte contributes to its
 * SHA-256, including files larger than 2 MB; no size-only placeholders exist.
 */
export function snapshotTree(dir, options = {}) {
  const limits = {
    maxEntries: options.maxEntries ?? MAX_TREE_SNAPSHOT_ENTRIES,
    maxBytes: options.maxBytes ?? MAX_TREE_SNAPSHOT_BYTES,
  };
  assertPositiveBound(limits.maxEntries, "maxEntries");
  assertPositiveBound(limits.maxBytes, "maxBytes");
  const bounds = { entries: 0, fileBytes: 0 };
  const snap = {};
  for (const rel of listRecursive(dir, dir, bounds, limits).sort()) {
    const filePath = path.join(dir, rel);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(filePath);
      snap[rel] = {
        kind: "symlink",
        size: Buffer.byteLength(target),
        sha256: crypto.createHash("sha256").update(target).digest("hex"),
      };
    } else if (stat.isDirectory()) {
      snap[rel] = { kind: "directory", size: 0, sha256: "directory" };
    } else if (stat.isFile()) {
      snap[rel] = {
        kind: "file",
        size: stat.size,
        sha256: sha256RegularFile(filePath, stat, limits.maxBytes),
      };
    } else {
      throw new Error(`snapshot entry changed to an unsupported type: ${filePath}`);
    }
  }
  return snap;
}

export function summarizeSnapshot(snapshot) {
  const values = Object.values(snapshot);
  const files = values.filter((entry) => entry?.kind === "file");
  return {
    entries: values.length,
    regularFiles: files.length,
    regularFileBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    hash: "sha256-all-regular-file-bytes",
  };
}

export function diffSnapshots(before, after) {
  const added = Object.keys(after).filter((key) => !(key in before));
  const removed = Object.keys(before).filter((key) => !(key in after));
  const changed = Object.keys(after)
    .filter((key) => key in before && JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  return { added, removed, changed };
}
