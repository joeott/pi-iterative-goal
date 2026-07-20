#!/usr/bin/env node

import { appendManagedLog } from "../dist/logging.js";

const [cwd, stream, rawCount] = process.argv.slice(2);
const count = Number(rawCount);
if (!cwd || !stream || !Number.isSafeInteger(count) || count < 1 || count > 10_000) {
  throw new Error("usage: logging-concurrency-worker.mjs CWD STREAM COUNT");
}
for (let index = 0; index < count; index += 1) {
  appendManagedLog(stream, "multiprocess-smoke", `pid=${process.pid} index=${index}`, { cwd, required: true });
}
