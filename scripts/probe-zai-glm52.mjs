#!/usr/bin/env node
import { probeZaiGlm52 } from "../dist/zai.js";

const cwd = process.cwd();
const envFiles = [];
let timeoutMs = 60_000;
let retries = 2;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--env-file" && process.argv[i + 1]) {
    envFiles.push(process.argv[i + 1]);
    i += 1;
  } else if (process.argv[i] === "--timeout-ms" && process.argv[i + 1]) {
    timeoutMs = Number(process.argv[i + 1]);
    i += 1;
  } else if (process.argv[i] === "--retries" && process.argv[i + 1]) {
    retries = Number(process.argv[i + 1]);
    i += 1;
  }
}

let result = null;
for (let attempt = 1; attempt <= Math.max(1, retries + 1); attempt += 1) {
  result = await probeZaiGlm52({
    cwd,
    explicitEnvFiles: envFiles,
    timeoutMs,
  });
  if (result.ok) break;
  if (attempt <= retries) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
}

console.log("probe_zai_glm52");
console.log(`  ok: ${String(result.ok)}`);
console.log(`  status: ${result.status ?? "none"}`);
console.log(`  model: ${result.model}`);
console.log(`  base_url: ${result.baseUrl}`);
console.log(`  latency_ms: ${result.latencyMs}`);
console.log(`  env_files_loaded: ${result.envFiles.length}`);
for (const envFile of result.envFiles) {
  console.log(`    - ${envFile.path}: ${envFile.loadedKeys.join(", ")}`);
}
console.log(`  response_text: ${result.text ? result.text.slice(0, 80).replace(/\s+/g, " ") : ""}`);
if (result.error) console.log(`  error: ${result.error}`);

process.exit(result.ok ? 0 : 1);
