#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(process.env.PI_ITERATIVE_GOAL_ROOT ?? new URL("..", import.meta.url).pathname);
const MATERIALIZE_FLAG = "--operator-approved-local-secret-materialization";
const AWS_FLAG = "--operator-approved-aws-secrets-manager-write";
const DEFAULT_SECRET_NAME = "pi-iterative-goal/model-provider-tokens";
const DEFAULT_CONTROL_AWS_PROFILE = "unify-old";
const DEFAULT_CONTROL_AWS_ACCOUNT = "371292405073";
const DEFAULT_PROJECT_AWS_PROFILE = "api-admin";
const DEFAULT_PROJECT_AWS_ACCOUNT = "138881449763";
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "PINECONE_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "ZAI_API_BASE_URL",
  "Z_AI_API_BASE_URL",
  "ZAI_DEFAULT_MODEL",
  "ZAI_DEFAULT_VISION_MODEL",
  "GLM_API_KEY",
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has(MATERIALIZE_FLAG);
const writeAws = args.has(AWS_FLAG);
const secretName = argValue("--secret-name") ?? DEFAULT_SECRET_NAME;
const region = argValue("--region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const existingHarnessEnv = parseEnvFile(path.join(ROOT, ".env"));
const awsScope = argValue("--aws-scope") ?? existingHarnessEnv.PI_AWS_SECRET_SCOPE ?? process.env.PI_AWS_SECRET_SCOPE ?? "control";
const controlAwsProfile = argValue("--control-aws-profile")
  ?? argValue("--aws-profile")
  ?? existingHarnessEnv.PI_AWS_CONTROL_PROFILE
  ?? process.env.PI_AWS_CONTROL_PROFILE
  ?? DEFAULT_CONTROL_AWS_PROFILE;
const expectedControlAwsAccount = argValue("--expected-control-aws-account")
  ?? argValue("--expected-aws-account")
  ?? existingHarnessEnv.PI_AWS_CONTROL_ACCOUNT_ID
  ?? process.env.PI_AWS_CONTROL_ACCOUNT_ID
  ?? DEFAULT_CONTROL_AWS_ACCOUNT;
const projectAwsProfile = argValue("--project-aws-profile")
  ?? existingHarnessEnv.PI_AWS_PROJECT_PROFILE
  ?? process.env.PI_AWS_PROJECT_PROFILE
  ?? DEFAULT_PROJECT_AWS_PROFILE;
const expectedProjectAwsAccount = argValue("--expected-project-aws-account")
  ?? existingHarnessEnv.PI_AWS_PROJECT_ACCOUNT_ID
  ?? process.env.PI_AWS_PROJECT_ACCOUNT_ID
  ?? DEFAULT_PROJECT_AWS_ACCOUNT;

const externalSourcesEnabled = process.env.PI_PROVIDER_ENV_DISABLE_DEFAULT_SOURCES !== "1";
const sources = {
  harnessEnv: path.join(ROOT, ".env"),
  piModels: "/Users/joe/.pi/agent/models.json",
  piAuth: "/Users/joe/.pi/agent/auth.json",
  projectsEnv: "/Users/joe/Projects/.env",
  unifyLocalEnv: "/Users/joe/Projects/unify_local/tmp/pi_unify_launcher/.env",
  zaiEnv: "/Users/joe/docker/claude-zai/.env",
};

const values = {};
const sourceHits = [];

loadEnvFile(sources.harnessEnv, PROVIDER_KEYS);
if (externalSourcesEnabled) {
  loadPiModels();
  loadPiAuth();
  loadEnvFile(sources.projectsEnv, [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROQ_API_KEY",
    "PINECONE_API_KEY",
    "LANGCHAIN_API_KEY",
    "LANGSMITH_API_KEY",
  ]);
  loadEnvFile(sources.unifyLocalEnv, [
    "ZAI_API_KEY",
    "ZAI_API_BASE_URL",
    "ZAI_DEFAULT_MODEL",
    "ZAI_DEFAULT_VISION_MODEL",
  ]);
  loadEnvFile(sources.zaiEnv, [
    "ZAI_API_KEY",
    "ZAI_API_BASE_URL",
    "ZAI_DEFAULT_MODEL",
    "ZAI_DEFAULT_VISION_MODEL",
  ]);
}

if (!values.ZAI_DEFAULT_MODEL) values.ZAI_DEFAULT_MODEL = "glm-5.2";
if (!values.ZAI_API_BASE_URL) values.ZAI_API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
values.PI_AWS_SECRET_SCOPE = awsScope;
values.PI_AWS_CONTROL_PROFILE = controlAwsProfile;
values.PI_AWS_CONTROL_ACCOUNT_ID = expectedControlAwsAccount;
values.PI_AWS_PROJECT_PROFILE = projectAwsProfile;
values.PI_AWS_PROJECT_ACCOUNT_ID = expectedProjectAwsAccount;

const orderedKeys = Object.keys(values).sort();
console.log("materialize_model_provider_env");
console.log(`  env_file: ${path.join(ROOT, ".env")}`);
console.log(`  dry_run: ${String(dryRun)}`);
console.log("  secrets_printed: false");
console.log(`  sources_with_mapped_keys: ${sourceHits.length}`);
for (const source of sourceHits) console.log(`    - ${source}`);
console.log(`  keys: ${orderedKeys.join(", ") || "none"}`);
console.log("  aws_accounts:");
console.log(`    control: profile=${controlAwsProfile} expected_account=${expectedControlAwsAccount} role=payments/provider-billing`);
console.log(`    project: profile=${projectAwsProfile} expected_account=${expectedProjectAwsAccount} role=project-runtime/sub-account`);

if (!dryRun) {
  const envPath = path.join(ROOT, ".env");
  fs.writeFileSync(envPath, renderEnv(values), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  console.log("  local_env_write: PASS");
} else {
  console.log(`  local_env_write: BLOCKED (${MATERIALIZE_FLAG} required)`);
}

if (writeAws) {
  if (dryRun) {
    console.log("  aws_secret_write: BLOCKED (local materialization approval flag also required)");
    process.exitCode = 2;
  } else if (!["control", "project", "both"].includes(awsScope)) {
    console.log("  aws_secret_write: BLOCKED");
    console.log("  reason: --aws-scope must be control, project, or both");
    process.exitCode = 2;
  } else {
    const targets = [];
    if (awsScope === "control" || awsScope === "both") {
      targets.push({ role: "control", profile: controlAwsProfile, expectedAccount: expectedControlAwsAccount });
    }
    if (awsScope === "project" || awsScope === "both") {
      targets.push({ role: "project", profile: projectAwsProfile, expectedAccount: expectedProjectAwsAccount });
    }
    console.log(`  aws_scope: ${awsScope}`);
    for (const target of targets) {
      const result = persistAwsSecretTarget(target);
      if (!result.ok) process.exitCode = 2;
    }
  }
} else {
  console.log(`  aws_secret_write: SKIPPED (${AWS_FLAG} not set)`);
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnv(fs.readFileSync(filePath, "utf8"));
}

function setValue(key, value, source) {
  if (!value || isPlaceholderSecret(key, value)) return;
  if (!values[key]) values[key] = value;
  if (!sourceHits.includes(source)) sourceHits.push(source);
}

function isPlaceholderSecret(key, value) {
  const normalized = String(value).trim();
  return normalized === "REPLACE_ME"
    || normalized === key
    || normalized === `<${key}>`
    || /^your[-_]/i.test(normalized)
    || /^changeme$/i.test(normalized)
    || /^placeholder$/i.test(normalized);
}

function loadPiModels() {
  if (!fs.existsSync(sources.piModels)) return;
  const models = JSON.parse(fs.readFileSync(sources.piModels, "utf8"));
  const providers = models.providers ?? {};
  const map = {
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    xai: "XAI_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    groq: "GROQ_API_KEY",
  };
  for (const [provider, key] of Object.entries(map)) {
    setValue(key, providers[provider]?.apiKey, sources.piModels);
  }
  if (providers.zai?.baseUrl) setValue("ZAI_API_BASE_URL", providers.zai.baseUrl, sources.piModels);
}

function loadPiAuth() {
  if (!fs.existsSync(sources.piAuth)) return;
  const auth = JSON.parse(fs.readFileSync(sources.piAuth, "utf8"));
  if (auth.openrouter?.key) setValue("OPENROUTER_API_KEY", auth.openrouter.key, sources.piAuth);
}

function loadEnvFile(filePath, allowedKeys) {
  if (!fs.existsSync(filePath)) return;
  const parsed = parseEnv(fs.readFileSync(filePath, "utf8"));
  for (const key of allowedKeys) setValue(key, parsed[key], filePath);
}

function parseEnv(text) {
  const parsed = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function renderEnv(envValues) {
  const header = [
    "# pi-iterative-goal local model-provider environment.",
    "# Generated by scripts/materialize-model-provider-env.mjs.",
    "# Do not commit this file.",
    "",
  ];
  return header.concat(Object.keys(envValues).sort().map((key) => `${key}=${shellEscape(envValues[key])}`), "").join("\n");
}

function shellEscape(value) {
  if (/^[A-Za-z0-9_./:@+\-=]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function getAwsIdentity(profile) {
  const result = spawnSync("aws", ["sts", "get-caller-identity", "--profile", profile, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return { ok: false, account: null, reason: result.stderr.trim().split(/\r?\n/).at(-1) ?? "sts failed" };
  try {
    const parsed = JSON.parse(result.stdout);
    return { ok: true, account: parsed.Account, reason: null };
  } catch {
    return { ok: false, account: null, reason: "could not parse sts identity" };
  }
}

function putSecret(name, envValues, awsRegion, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-secret-"));
  const secretPath = path.join(dir, "secret.json");
  fs.writeFileSync(secretPath, JSON.stringify(envValues, null, 2), { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
  try {
    const describe = spawnSync("aws", ["secretsmanager", "describe-secret", "--secret-id", name, "--region", awsRegion, "--profile", profile, "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const command = describe.status === 0
      ? ["secretsmanager", "put-secret-value", "--secret-id", name, "--secret-string", `file://${secretPath}`, "--region", awsRegion, "--profile", profile, "--output", "json"]
      : ["secretsmanager", "create-secret", "--name", name, "--description", "pi-iterative-goal consolidated model provider tokens", "--secret-string", `file://${secretPath}`, "--region", awsRegion, "--profile", profile, "--output", "json"];
    const result = spawnSync("aws", command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return { ok: false, reason: result.stderr.trim().split(/\r?\n/).at(-1) ?? "aws cli failed" };
    return { ok: true, reason: null };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function persistAwsSecretTarget(target) {
  const identity = getAwsIdentity(target.profile);
  console.log(`  aws_${target.role}_profile: ${target.profile}`);
  console.log(`  aws_${target.role}_expected_account: ${target.expectedAccount}`);
  console.log(`  aws_${target.role}_resolved_account: ${identity.account ?? "unavailable"}`);
  if (!identity.ok) {
    console.log(`  aws_${target.role}_secret_write: FAIL`);
    console.log(`  reason: ${identity.reason}`);
    return { ok: false };
  }
  if (identity.account !== target.expectedAccount) {
    console.log(`  aws_${target.role}_secret_write: BLOCKED`);
    console.log(`  reason: resolved AWS account does not match expected ${target.role} account`);
    return { ok: false };
  }
  const result = putSecret(secretName, values, region, target.profile);
  console.log(`  aws_${target.role}_secret_name: ${secretName}`);
  console.log(`  aws_${target.role}_region: ${region}`);
  console.log(`  aws_${target.role}_secret_write: ${result.ok ? "PASS" : "FAIL"}`);
  if (!result.ok) console.log(`  reason: ${result.reason}`);
  return result;
}
