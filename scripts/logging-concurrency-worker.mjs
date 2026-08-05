#!/usr/bin/env node

import { appendManagedLog } from "../dist/logging.js";

const [cwd, stream, rawCount, rawStartAt] = process.argv.slice(2);
const count = Number(rawCount);
if (!cwd || !stream || !Number.isSafeInteger(count) || count < 1 || count > 10_000) {
  throw new Error("usage: logging-concurrency-worker.mjs CWD STREAM COUNT [START_AT_EPOCH_MS]");
}
if (rawStartAt !== undefined) {
  const startAt = Number(rawStartAt);
  if (!Number.isSafeInteger(startAt) || startAt < Date.now() - 60_000 || startAt > Date.now() + 60_000) {
    throw new Error("START_AT_EPOCH_MS must be an epoch millisecond within 60 seconds of now");
  }
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < startAt) {
    Atomics.wait(waiter, 0, 0, Math.min(25, startAt - Date.now()));
  }
}
for (let index = 0; index < count; index += 1) {
  appendManagedLog(stream, "multiprocess-smoke", `pid=${process.pid} index=${index}`, { cwd, required: true });
}
