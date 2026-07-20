import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXACT_MODEL_IDENTITY_API } from "./worker-extension.js";

export const ZAI_PROVIDER = "zai";
export const ZAI_GLM_5_2_MODEL = "glm-5.2";
export const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export interface LoadedEnvFile {
  path: string;
  loadedKeys: string[];
}

export interface ZaiProbeResult {
  ok: boolean;
  status: number | null;
  model: string;
  baseUrl: string;
  latencyMs: number;
  text: string;
  error: string | null;
  envFiles: LoadedEnvFile[];
}

export function loadZaiLocalEnv(cwd: string, explicitPaths: string[] = []): LoadedEnvFile[] {
  const loaded: LoadedEnvFile[] = [];
  for (const envPath of discoverZaiEnvFiles(cwd, explicitPaths)) {
    if (!fs.existsSync(envPath)) continue;
    const parsed = parseDotEnv(fs.readFileSync(envPath, "utf8"));
    const loadedKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      // Local files may supply credentials, never route/model overrides. The
      // exact endpoint and metadata are code/roster owned.
      if (key !== "ZAI_API_KEY" && key !== "Z_AI_API_KEY") continue;
      if (isPlaceholderSecret(key, value)) continue;
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loadedKeys.push(key);
      }
    }
    // Report every explicit/discovered file that was inspected, even when it
    // contained only placeholders or forbidden route overrides. This keeps
    // diagnostics truthful without exposing values.
    loaded.push({ path: envPath, loadedKeys });
  }
  return loaded;
}

function isPlaceholderSecret(key: string, value: string): boolean {
  const normalized = value.trim();
  return normalized === ""
    || normalized === "REPLACE_ME"
    || normalized === key
    || normalized === `<${key}>`
    || /^your[-_]/i.test(normalized)
    || /^changeme$/i.test(normalized)
    || /^placeholder$/i.test(normalized);
}

export function registerZaiGlm52Provider(ctx: ExtensionContext | ExtensionCommandContext): LoadedEnvFile[] {
  // Runtime launchers inject only approved credential variables. Re-scanning
  // repository/ancestor/home env files here would let ambient configuration
  // replace the tracked exact route after models.json loads.
  const loaded: LoadedEnvFile[] = [];
  const apiKey = process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY;
  const baseUrl = ZAI_CODING_BASE_URL;
  const registerProvider = (ctx.modelRegistry as any).registerProvider;
  if (typeof registerProvider === "function") {
    registerProvider.call(ctx.modelRegistry, ZAI_PROVIDER, {
      name: "Z.ai",
      api: EXACT_MODEL_IDENTITY_API,
      baseUrl,
      apiKey,
      authHeader: true,
      models: [zaiGlm52Model(baseUrl)],
    });
  }
  return loaded;
}

export function registerZaiGlm52ProviderWithPi(pi: ExtensionAPI, cwd = process.cwd()): LoadedEnvFile[] {
  void cwd;
  const loaded: LoadedEnvFile[] = [];
  const apiKey = process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY;
  const baseUrl = ZAI_CODING_BASE_URL;
  pi.registerProvider(ZAI_PROVIDER, {
    name: "Z.ai",
    api: EXACT_MODEL_IDENTITY_API,
    baseUrl,
    apiKey,
    authHeader: true,
    models: [zaiGlm52Model(baseUrl)],
  });
  return loaded;
}

export function zaiGlm52Model(baseUrl = ZAI_CODING_BASE_URL) {
  // Keep the optional argument for API compatibility, but never honor a
  // caller-supplied endpoint in the exact production model definition.
  void baseUrl;
  return {
    id: ZAI_GLM_5_2_MODEL,
    name: "GLM-5.2",
    api: EXACT_MODEL_IDENTITY_API,
    baseUrl: ZAI_CODING_BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "zai",
      zaiToolStream: true,
      maxTokensField: "max_tokens",
    } as const,
  };
}

export async function probeZaiGlm52(params: {
  cwd: string;
  explicitEnvFiles?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ZaiProbeResult> {
  const envFiles = loadZaiLocalEnv(params.cwd, params.explicitEnvFiles ?? []);
  const apiKey = process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY;
  const baseUrl = ZAI_CODING_BASE_URL;
  const started = Date.now();
  if (!apiKey) {
    return {
      ok: false,
      status: null,
      model: ZAI_GLM_5_2_MODEL,
      baseUrl,
      latencyMs: Date.now() - started,
      text: "",
      error: "ZAI_API_KEY not found in process.env or loaded .env files.",
      envFiles,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 20_000);
  timeout.unref();
  try {
    const response = await (params.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
      },
      body: JSON.stringify({
        model: ZAI_GLM_5_2_MODEL,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        temperature: 0,
        max_tokens: 32,
        enable_thinking: false,
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    let text = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body);
      text = parsed?.choices?.[0]?.message?.content ?? text;
    } catch {
      // Keep raw snippet.
    }
    return {
      ok: response.ok && (/\bOK\b/i.test(text) || statusLooksResponsive(response.status, text)),
      status: response.status,
      model: ZAI_GLM_5_2_MODEL,
      baseUrl,
      latencyMs: Date.now() - started,
      text,
      error: response.ok ? null : `HTTP ${response.status}: ${text.slice(0, 200)}`,
      envFiles,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      model: ZAI_GLM_5_2_MODEL,
      baseUrl,
      latencyMs: Date.now() - started,
      text: "",
      error: err instanceof Error ? err.message : String(err),
      envFiles,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function statusLooksResponsive(status: number, text: string): boolean {
  return status === 200 && text.length > 0;
}

function discoverZaiEnvFiles(cwd: string, explicitPaths: string[]): string[] {
  const candidates = new Set<string>();
  for (const envPath of explicitPaths) candidates.add(path.resolve(cwd, envPath));
  for (const envPath of (process.env.PI_ITERATIVE_GOAL_ENV_FILE ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.add(path.resolve(cwd, envPath));
  }

  let current = path.resolve(cwd);
  while (true) {
    candidates.add(path.join(current, ".env"));
    candidates.add(path.join(current, ".env.local"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.add(path.join(os.homedir(), ".env"));
  candidates.add(path.join(os.homedir(), "Projects", "unify_local", "tmp", "pi_unify_launcher", ".env"));
  candidates.add(path.join(os.homedir(), "docker", "claude-zai", ".env"));
  return [...candidates];
}

function parseDotEnv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}
