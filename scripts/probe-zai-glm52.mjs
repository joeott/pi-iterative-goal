#!/usr/bin/env node
import { probeZaiGlm52 } from "../dist/zai.js";

const cwd = process.cwd();
const envFiles = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--env-file" && process.argv[i + 1]) {
    envFiles.push(process.argv[i + 1]);
    i += 1;
  }
}

const result = await probeZaiGlm52({
  cwd,
  explicitEnvFiles: envFiles,
  timeoutMs: 20_000,
});

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
