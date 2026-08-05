#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_CREDENTIALS,
  REPOSITORY_ROOT,
  createOpenCodeConfig,
  createPiFiles,
  equalJson,
  loadRoster,
  materializeRuntime,
} from "./lib/model-runtime.mjs";

const options = parseArgs(process.argv.slice(2));
const rosterPath = path.resolve(options.roster ?? path.join(REPOSITORY_ROOT, "config", "model-roster.json"));
const piDir = path.resolve(options.piDir ?? path.join(REPOSITORY_ROOT, ".pi", "iterative-goal", "runtime", "pi-agent"));
const openCodeOutput = path.resolve(options.openCodeOutput ?? path.join(REPOSITORY_ROOT, ".opencode", "opencode.json"));
const roster = loadRoster(rosterPath);
const expectedPi = createPiFiles(roster, piDir);
const expectedOpenCode = createOpenCodeConfig(roster);

if (options.check) {
  const failures = [];
  if (!readEquals(openCodeOutput, expectedOpenCode)) failures.push(openCodeOutput);
  if (fs.existsSync(piDir)) {
    for (const [name, value] of Object.entries(expectedPi)) {
      const filePath = path.join(piDir, name);
      if (!readEquals(filePath, value)) failures.push(filePath);
    }
  }
  printSummary("check", roster, piDir, openCodeOutput);
  if (failures.length) {
    console.error(`runtime config drift: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("status: PASS");
} else if (options.write) {
  materializeRuntime({ roster, piDir, openCodeOutput });
  printSummary("write", roster, piDir, openCodeOutput);
  console.log(`launch: PI_CODING_AGENT_DIR=${shellQuote(piDir)} node_modules/.bin/pi`);
} else {
  printSummary("preview", roster, piDir, openCodeOutput);
  console.log("writes: none (--write is required to materialize files)");
}

function parseArgs(args) {
  const result = { write: false, check: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") result.write = true;
    else if (arg === "--check") result.check = true;
    else if (["--roster", "--pi-dir", "--opencode-output"].includes(arg)) {
      if (!args[index + 1]) throw new Error(`${arg} requires a value`);
      result[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = args[++index];
    } else if (arg === "--help") {
      console.log("usage: materialize-goal-runtime.mjs [--write|--check] [--pi-dir DIR] [--opencode-output FILE] [--roster FILE]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (result.write && result.check) throw new Error("--write and --check are mutually exclusive");
  return result;
}

function readEquals(filePath, expected) {
  try {
    return equalJson(JSON.parse(fs.readFileSync(filePath, "utf8")), expected);
  } catch {
    return false;
  }
}

function printSummary(mode, roster, runtimeDir, configPath) {
  console.log("goal_runtime_materializer");
  console.log(`mode: ${mode}`);
  console.log(`catalog_hash: ${roster.catalogHash}`);
  console.log(`profiles: ${roster.profiles.length}`);
  console.log(`credentials: ${ALLOWED_CREDENTIALS.join(",")}`);
  console.log("secret_values_written: false");
  console.log(`pi_coding_agent_dir: ${runtimeDir}`);
  console.log(`opencode_config: ${configPath}`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
