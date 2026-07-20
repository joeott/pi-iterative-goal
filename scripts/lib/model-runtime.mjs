import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const EXPECTED_PROFILES = Object.freeze({
  zai_glm_5_2: ["zai", "glm-5.2", "ZAI_API_KEY"],
  fireworks_glm_5_2_max: ["fireworks", "accounts/fireworks/models/glm-5p2", "FIREWORKS_API_KEY"],
  fireworks_glm_5_2_fast: ["fireworks", "accounts/fireworks/routers/glm-5p2-fast", "FIREWORKS_API_KEY"],
  openrouter_kimi_k3: ["openrouter", "moonshotai/kimi-k3", "OPENROUTER_API_KEY"],
  cerebras_gpt_oss_120b: ["cerebras", "gpt-oss-120b", "CEREBRAS_API_KEY"],
  cerebras_glm_4_7: ["cerebras", "zai-glm-4.7", "CEREBRAS_API_KEY"],
  cerebras_gemma_4_31b: ["cerebras", "gemma-4-31b", "CEREBRAS_API_KEY"],
  openrouter_claude_sonnet_5: ["openrouter", "anthropic/claude-sonnet-5", "OPENROUTER_API_KEY"],
  openrouter_claude_fable_5: ["openrouter", "anthropic/claude-fable-5", "OPENROUTER_API_KEY"],
});

export const ALLOWED_CREDENTIALS = Object.freeze([
  "ZAI_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
]);

export const PROVIDERS = Object.freeze({
  zai: {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    piApi: "pi-iterative-goal-exact-openai-completions",
    piCompat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "zai" },
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    piApi: "pi-iterative-goal-exact-openai-completions",
    piCompat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "reasoning_effort" },
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    piApi: "pi-iterative-goal-exact-openai-completions",
    piCompat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "openrouter" },
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    piApi: "pi-iterative-goal-exact-openai-completions",
    piCompat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  },
});

const EXACT_IDS = Object.keys(EXPECTED_PROFILES);
const PROVIDER_ORDER = Object.keys(PROVIDERS);
const SECRET_PATTERN = /(?:sk-(?:or-v1-)?|fw_)[A-Za-z0-9._-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function rosterDigest(roster) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(roster))).digest("hex");
}

export function loadRoster(rosterPath = path.join(REPOSITORY_ROOT, "config", "model-roster.json")) {
  const parsed = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.profiles)) {
    throw new Error("model roster must use schemaVersion 1 and contain profiles");
  }
  if (parsed.profiles.length !== EXACT_IDS.length) {
    throw new Error(`model roster must contain exactly ${EXACT_IDS.length} profiles`);
  }
  const seen = new Set();
  for (const profile of parsed.profiles) {
    const expected = EXPECTED_PROFILES[profile?.id];
    if (!expected) throw new Error(`unlisted model profile: ${String(profile?.id)}`);
    if (seen.has(profile.id)) throw new Error(`duplicate model profile: ${profile.id}`);
    seen.add(profile.id);
    const actual = [profile.provider, profile.model, profile.credential?.primaryEnv];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${profile.id} must resolve exactly to ${expected.join(" / ")}`);
    }
    if (!PROVIDERS[profile.provider]) throw new Error(`unsupported provider: ${profile.provider}`);
    if (!profile.capabilities || typeof profile.capabilities.contextWindow !== "number") {
      throw new Error(`${profile.id} is missing capability metadata`);
    }
    if (!profile.reasoning || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(profile.reasoning.piThinkingLevel)) {
      throw new Error(`${profile.id} has an invalid Pi thinking level`);
    }
    if (profile.serving?.serviceTier !== "standard") {
      throw new Error(`${profile.id} must use the standard service tier`);
    }
  }
  if (EXACT_IDS.some((id) => !seen.has(id))) throw new Error("model roster is missing a required profile");
  const primaryCredentials = [...new Set(parsed.profiles.map((profile) => profile.credential.primaryEnv))].sort();
  if (JSON.stringify(primaryCredentials) !== JSON.stringify([...ALLOWED_CREDENTIALS].sort())) {
    throw new Error(`model roster must use only these credential names: ${ALLOWED_CREDENTIALS.join(", ")}`);
  }
  return Object.freeze({ ...parsed, catalogHash: rosterDigest(parsed) });
}

function maxOutputTokens(profile) {
  return Math.min(32768, Math.max(4096, Math.floor(profile.capabilities.contextWindow / 4)));
}

function piThinkingLevelMap(profile) {
  if (!profile.capabilities.reasoning) return undefined;
  const supported = profile.reasoning.piThinkingLevel;
  const result = {};
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    result[level] = level === supported ? (profile.reasoning.providerEffort ?? level) : null;
  }
  return result;
}

export function createPiFiles(roster, piDir, repositoryRoot = REPOSITORY_ROOT) {
  const providers = {};
  for (const providerId of PROVIDER_ORDER) {
    const spec = PROVIDERS[providerId];
    const profiles = roster.profiles.filter((profile) => profile.provider === providerId);
    if (profiles.length === 0) continue;
    providers[providerId] = {
      baseUrl: spec.baseUrl,
      api: spec.piApi,
      apiKey: profiles[0].credential.primaryEnv,
      authHeader: true,
      compat: spec.piCompat,
      models: profiles.map((profile) => {
        const model = {
          id: profile.model,
          name: profile.id,
          reasoning: profile.capabilities.reasoning,
          input: profile.capabilities.images ? ["text", "image"] : ["text"],
          contextWindow: profile.capabilities.contextWindow,
          maxTokens: maxOutputTokens(profile),
        };
        const thinkingLevelMap = piThinkingLevelMap(profile);
        if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
        return model;
      }),
    };
  }
  const enabledModels = roster.profiles.map((profile) => `${profile.provider}/${profile.model}`);
  return {
    "settings.json": {
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      defaultThinkingLevel: "high",
      enabledModels,
      packages: [],
      extensions: [path.join(repositoryRoot, "dist", "pi-iterative-goal.js")],
      prompts: [path.join(repositoryRoot, ".pi", "prompts", "goal.md")],
      sessionDir: path.join(path.resolve(piDir), "sessions"),
      quietStartup: false,
    },
    "models.json": { providers },
  };
}

export function createOpenCodeConfig(roster) {
  const provider = {};
  for (const providerId of PROVIDER_ORDER) {
    const profiles = roster.profiles.filter((profile) => profile.provider === providerId);
    if (profiles.length === 0) continue;
    const models = {};
    for (const profile of profiles) {
      const options = {};
      if (profile.reasoning.providerEffort) options.reasoningEffort = profile.reasoning.providerEffort;
      if (providerId === "openrouter") {
        options.provider = { allow_fallbacks: false };
      }
      models[profile.model] = {
        name: profile.id,
        reasoning: profile.capabilities.reasoning,
        limit: {
          context: profile.capabilities.contextWindow,
          output: maxOutputTokens(profile),
        },
        ...(Object.keys(options).length ? { options } : {}),
      };
    }
    provider[providerId] = {
      npm: "@ai-sdk/openai-compatible",
      name: `pi-iterative-goal ${providerId}`,
      options: {
        baseURL: PROVIDERS[providerId].baseUrl,
        apiKey: `{env:${profiles[0].credential.primaryEnv}}`,
      },
      models,
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    instructions: ["goal.md", "northstar.md", "state.md", "learnings.md"],
    model: "zai/glm-5.2",
    small_model: "cerebras/gpt-oss-120b",
    enabled_providers: PROVIDER_ORDER,
    provider,
    compaction: { auto: true, prune: true, reserved: 12000 },
    watcher: {
      ignore: [".git/", "node_modules/", "dist/", ".pi/iterative-goal/managed/", "*.log"],
    },
  };
}

function assertPlainConfig(value, label) {
  const serialized = JSON.stringify(value);
  if (SECRET_PATTERN.test(serialized)) throw new Error(`${label} appears to contain a literal credential`);
  for (const credential of ALLOWED_CREDENTIALS) {
    const secret = process.env[credential];
    if (secret && secret.length >= 8 && serialized.includes(secret)) {
      throw new Error(`${label} contains the value of ${credential}`);
    }
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing to replace symlink: ${filePath}`);
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function materializeRuntime({ roster, piDir, openCodeOutput, repositoryRoot = REPOSITORY_ROOT }) {
  const piFiles = materializePiRuntime({ roster, piDir, repositoryRoot });
  const openCode = createOpenCodeConfig(roster);
  assertPlainConfig(openCode, "OpenCode configuration");
  writeJsonAtomic(openCodeOutput, openCode);
  return { piFiles, openCode };
}

export function materializePiRuntime({ roster, piDir, repositoryRoot = REPOSITORY_ROOT }) {
  const piFiles = createPiFiles(roster, piDir, repositoryRoot);
  assertPlainConfig(piFiles, "Pi configuration");
  for (const [name, value] of Object.entries(piFiles)) writeJsonAtomic(path.join(piDir, name), value);
  fs.mkdirSync(path.join(piDir, "sessions"), { recursive: true, mode: 0o700 });
  return piFiles;
}

export function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
