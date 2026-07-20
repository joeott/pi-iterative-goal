#!/usr/bin/env node
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  diffSnapshots,
  snapshotTree,
  summarizeSnapshot,
} from "./lib/bounded-tree-snapshot.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-tree-snapshot-"));
try {
  const largePath = path.join(scratch, "over-2mb.bin");
  const bytes = Buffer.alloc(2_000_001, 0x61);
  fs.writeFileSync(largePath, bytes, { flag: "wx", mode: 0o600 });
  const before = snapshotTree(scratch);
  assert.match(before["over-2mb.bin"].sha256, /^[a-f0-9]{64}$/);
  assert.equal(before["over-2mb.bin"].sha256,
    crypto.createHash("sha256").update(bytes).digest("hex"),
    "files over 2 MB must hash all bytes, never use a size-only marker");

  const descriptor = fs.openSync(largePath, "r+");
  try {
    fs.writeSync(descriptor, Buffer.from([0x62]), 0, 1, bytes.length - 1);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const after = snapshotTree(scratch);
  assert.equal(after["over-2mb.bin"].size, before["over-2mb.bin"].size);
  assert.notEqual(after["over-2mb.bin"].sha256, before["over-2mb.bin"].sha256);
  assert.deepEqual(diffSnapshots(before, after), {
    added: [],
    removed: [],
    changed: ["over-2mb.bin"],
  }, "same-size content drift must remain visible above the old 2 MB cutoff");
  assert.deepEqual(summarizeSnapshot(after), {
    entries: 1,
    regularFiles: 1,
    regularFileBytes: bytes.length,
    hash: "sha256-all-regular-file-bytes",
  });
  assert.throws(() => snapshotTree(scratch, { maxBytes: bytes.length - 1 }),
    /bounded entry\/byte census/,
    "the configured byte census must fail closed before an unbounded snapshot");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("bounded-tree-snapshot: PASS (all >2 MB bytes hashed; same-size drift detected; census enforced)");
