#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_CREDENTIALS,
  REPOSITORY_ROOT,
  createOpenCodeConfig,
  equalJson,
  loadRoster,
  materializePiRuntime,
} from "./lib/model-runtime.mjs";

const options = parseArgs(process.argv.slice(2));
const roster = loadRoster(options.roster);
const piDir = path.resolve(options.piDir ?? path.join(REPOSITORY_ROOT, ".pi", "iterative-goal", "runtime", "pi-agent"));
const openCodePath = path.join(REPOSITORY_ROOT, ".opencode", "opencode.json");
assertTrackedOpenCode(openCodePath, createOpenCodeConfig(roster));
validateModelArguments(options.piArgs, roster);
materializePiRuntime({ roster, piDir });

console.log("goal_runtime_launcher");
console.log(`catalog_hash: ${roster.catalogHash}`);
console.log(`pi_coding_agent_dir: ${piDir}`);
console.log(`profiles: ${roster.profiles.length}`);
console.log(`credentials_present: ${ALLOWED_CREDENTIALS.filter((name) => Boolean(process.env[name])).join(",") || "none"}`);
console.log("secret_values_written: false");

if (options.materializeOnly) {
  console.log("launch: SKIPPED (--materialize-only)");
  process.exit(0);
}

const piExecutable = path.join(REPOSITORY_ROOT, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
if (!fs.existsSync(piExecutable)) throw new Error(`repository-local Pi executable is missing: ${piExecutable}`);
const extensionPath = path.join(REPOSITORY_ROOT, "dist", "pi-iterative-goal.js");
if (!fs.existsSync(extensionPath)) {
  throw new Error("dist/pi-iterative-goal.js is missing; run npm run build first");
}
// Disable every ambient extension directory/package, then load this exact
// built artifact explicitly. This makes the request-time roster policy
// non-optional even though Pi's catalog can still enumerate built-ins.
const effectivePiArgs = ["--no-extensions", "--extension", extensionPath, ...options.piArgs];

const child = spawn(piExecutable, effectivePiArgs, {
  cwd: REPOSITORY_ROOT,
  env: createLaunchEnvironment(piDir),
  stdio: "inherit",
  shell: false,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once("error", (error) => {
  console.error(`Pi launch failed: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Pi exited from signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

export function createLaunchEnvironment(runtimeDir, source = process.env) {
  const environment = {};
  const safeNames = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "TMPDIR",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSH_AUTH_SOCK", "EDITOR", "VISUAL", "PAGER",
    "NO_COLOR", "FORCE_COLOR", "CI",
  ];
  for (const name of safeNames) if (source[name] !== undefined) environment[name] = source[name];
  for (const name of ALLOWED_CREDENTIALS) if (source[name]) environment[name] = source[name];
  environment.PI_CODING_AGENT_DIR = runtimeDir;
  environment.PI_ITERATIVE_GOAL_ROOT = REPOSITORY_ROOT;
  environment.PI_TELEMETRY = "0";
  return environment;
}

function assertTrackedOpenCode(filePath, expected) {
  let actual;
  try { actual = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { throw new Error(`tracked OpenCode configuration is missing or invalid: ${filePath}`); }
  if (!equalJson(actual, expected)) {
    throw new Error("tracked OpenCode configuration has drifted; run npm run models:runtime:check");
  }
}

function validateModelArguments(args, roster) {
  const allowed = new Set(roster.profiles.map((profile) => `${profile.provider}/${profile.model}`));
  const allowedProviders = new Set(roster.profiles.map((profile) => profile.provider));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--api-key", "--extension", "-e", "--no-extensions", "-ne", "--no-prompt-templates", "-np"].includes(arg)
      || /^(?:--api-key|--extension|--no-extensions|--no-prompt-templates)=/.test(arg)) {
      throw new Error("credential, extension, and prompt-policy overrides are disabled by the goal runtime policy");
    }
    if (arg === "--model" || arg === "-m") {
      const selection = args[++index];
      if (!selection || !allowed.has(selection)) throw new Error(`unlisted Pi model selection: ${selection ?? "missing"}`);
    } else if (arg === "--models") {
      const selections = (args[++index] ?? "").split(",").filter(Boolean);
      if (!selections.length || selections.some((selection) => !allowed.has(selection))) {
        throw new Error("--models may contain only exact roster selections");
      }
    } else if (arg.startsWith("--model=")) {
      const selection = arg.slice("--model=".length);
      if (!allowed.has(selection)) throw new Error(`unlisted Pi model selection: ${selection}`);
    } else if (arg.startsWith("--models=")) {
      const selections = arg.slice("--models=".length).split(",").filter(Boolean);
      if (!selections.length || selections.some((selection) => !allowed.has(selection))) {
        throw new Error("--models may contain only exact roster selections");
      }
    } else if (arg === "--provider") {
      const provider = args[++index];
      if (!provider || !allowedProviders.has(provider)) throw new Error(`unlisted Pi provider: ${provider ?? "missing"}`);
    } else if (arg.startsWith("--provider=")) {
      const provider = arg.slice("--provider=".length);
      if (!allowedProviders.has(provider)) throw new Error(`unlisted Pi provider: ${provider}`);
    }
  }
}

function parseArgs(args) {
  const result = { materializeOnly: false, piDir: undefined, roster: undefined, piArgs: [] };
  let passthrough = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (passthrough) result.piArgs.push(arg);
    else if (arg === "--") passthrough = true;
    else if (arg === "--materialize-only") result.materializeOnly = true;
    else if (arg === "--pi-dir" || arg === "--roster") {
      if (!args[index + 1]) throw new Error(`${arg} requires a value`);
      result[arg === "--pi-dir" ? "piDir" : "roster"] = path.resolve(args[++index]);
    } else if (arg === "--help") {
      console.log("usage: run-goal-runtime.mjs [--materialize-only] [--pi-dir DIR] [--roster FILE] [-- PI_ARGS...]");
      process.exit(0);
    } else throw new Error(`launcher argument must precede --; unknown argument: ${arg}`);
  }
  return result;
}
