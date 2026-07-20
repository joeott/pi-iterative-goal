import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  normalizeRepoPath,
  parsePathScope,
  pathInScopes,
  resolveContainedPath,
  type PathScope,
} from "./domain/path-scope.js";
import {
  MODEL_ROSTER,
  requireModelRoute,
  responseModelMatchesRoute,
  resolveModelRoute,
  type ModelProfileId,
  type ResolvedModelRoute,
} from "./domain/model-roster.js";
import { defaultDlpState, dlpScrubText } from "./cyber-runtime.js";

export const WORKER_ENV = Object.freeze({
  root: "PI_ITERATIVE_GOAL_WORKER_ROOT",
  mode: "PI_ITERATIVE_GOAL_WORKER_MODE",
  allowedPaths: "PI_ITERATIVE_GOAL_WORKER_ALLOWED_PATHS_B64",
  modelProfile: "PI_ITERATIVE_GOAL_WORKER_MODEL_PROFILE",
} as const);

export type WorkerMode = "read_only_snapshot" | "isolated_worktree";

export interface WorkerConfig {
  root: string;
  rootReal: string;
  mode: WorkerMode;
  allowedPaths: string[];
  allowedScopes: PathScope[];
  route: ResolvedModelRoute;
}

export interface WorkerExtensionControls {
  /** Injectable only for offline tests. Production marks the child failed. */
  failProcess?: (reason: string) => void;
}

const MAX_ALLOWED_PATHS_BYTES = 32 * 1024;
const MAX_ALLOWED_PATHS = 512;
const MAX_READ_BYTES = 64 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_MUTATION_BYTES = 1024 * 1024;
const MAX_SCAN_FILES = 5_000;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS = 500;
const SKIPPED_SCAN_DIRS = new Set([".git", ".pi", "dist", "node_modules"]);
const BLOCKED_READ_BASENAMES = new Set([
  ".npmrc", ".netrc", ".pypirc", ".git-credentials", "auth.json",
  "credentials.json", "service-account.json", "id_rsa", "id_ed25519",
]);
export const EXACT_MODEL_IDENTITY_API = "pi-iterative-goal-exact-openai-completions";

export type OpenAICompatibleWorkerStream = (
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const builtInOpenAICompatibleStream: OpenAICompatibleWorkerStream = (model, context, options) => {
  const provider = getApiProvider("openai-completions");
  if (!provider) throw new Error("Pi's built-in openai-completions adapter is unavailable.");
  return provider.streamSimple(model, context, options);
};

const PROVIDER_RUNTIME: Readonly<Record<string, {
  name: string;
  baseUrl: string;
  compat: Record<string, unknown>;
}>> = Object.freeze({
  zai: {
    name: "Z.ai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",
      zaiToolStream: true,
    },
  },
  fireworks: {
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "reasoning_effort",
    },
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openrouter",
    },
  },
  cerebras: {
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  },
});

const ReadParams = Type.Object({
  path: Type.String({ description: "Repository-relative file path" }),
  offset: Type.Optional(Type.Number({ minimum: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_READ_LINES })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ minLength: 1, maxLength: 4_096, description: "Fixed text to find" }),
  path: Type.Optional(Type.String({ description: "Repository-relative file or directory; defaults to root" })),
  glob: Type.Optional(Type.String({ maxLength: 512, description: "Optional repository-relative file glob" })),
  ignoreCase: Type.Optional(Type.Boolean()),
  maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_RESULTS })),
});

const FindParams = Type.Object({
  pattern: Type.String({ minLength: 1, maxLength: 512, description: "Repository-relative path glob" }),
  path: Type.Optional(Type.String({ description: "Repository-relative directory; defaults to root" })),
  maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_RESULTS })),
});

const LsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Repository-relative directory; defaults to root" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_RESULTS })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Repository-relative file path within the assigned write scope" }),
  content: Type.String({ maxLength: MAX_MUTATION_BYTES }),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Repository-relative file path within the assigned write scope" }),
  oldText: Type.String({ minLength: 1, maxLength: MAX_MUTATION_BYTES }),
  newText: Type.String({ maxLength: MAX_MUTATION_BYTES }),
});

export function encodeWorkerAllowedPaths(paths: readonly string[]): string {
  const normalized = paths.map((item) => normalizeRepoPath(item));
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json) > MAX_ALLOWED_PATHS_BYTES || normalized.length > MAX_ALLOWED_PATHS) {
    throw new Error("Worker allowed-path configuration exceeds its hard bound.");
  }
  return Buffer.from(json, "utf8").toString("base64url");
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const root = requiredEnv(env, WORKER_ENV.root);
  if (!path.isAbsolute(root)) throw new Error("Worker root must be absolute.");
  const rootReal = fs.realpathSync(root);
  if (!fs.statSync(rootReal).isDirectory()) throw new Error("Worker root must be a directory.");

  const mode = requiredEnv(env, WORKER_ENV.mode);
  if (mode !== "read_only_snapshot" && mode !== "isolated_worktree") {
    throw new Error(`Invalid worker mode: ${mode}`);
  }

  const encoded = requiredEnv(env, WORKER_ENV.allowedPaths);
  if (encoded.length > Math.ceil(MAX_ALLOWED_PATHS_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid worker allowed-path encoding.");
  }
  let decoded: unknown;
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.byteLength(raw) > MAX_ALLOWED_PATHS_BYTES) throw new Error("decoded value is too large");
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid worker allowed paths: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(decoded) || decoded.length > MAX_ALLOWED_PATHS || !decoded.every((item) => typeof item === "string")) {
    throw new Error("Worker allowed paths must be a bounded string array.");
  }
  const allowedPaths = decoded.map((item) => normalizeRepoPath(item));

  const profile = requiredEnv(env, WORKER_ENV.modelProfile);
  const route = requireModelRoute(profile as ModelProfileId);
  return {
    root,
    rootReal,
    mode,
    allowedPaths,
    allowedScopes: allowedPaths.map(parsePathScope),
    route,
  };
}

export function workerProviderConfig(
  route: ResolvedModelRoute,
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const provider = PROVIDER_RUNTIME[route.provider];
  if (!provider) throw new Error(`Worker provider is not supported: ${route.provider}`);
  const apiKey = route.credential.environment
    .map((key) => env[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const cost = {
    input: route.pricing.input ?? 0,
    output: route.pricing.output ?? 0,
    cacheRead: route.pricing.cacheRead ?? 0,
    cacheWrite: route.pricing.cacheWrite ?? 0,
  };
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    // A custom API wrapper makes the OpenAI-compatible adapter surface the
    // raw upstream chunk.model even when it equals the requested model. Pi's
    // built-in adapter intentionally omits responseModel in that case.
    api: EXACT_MODEL_IDENTITY_API,
    streamSimple: createExactIdentityWorkerStream(route),
    apiKey,
    authHeader: true,
    models: [{
      id: route.model,
      name: route.profileId,
      reasoning: route.capabilities.reasoning,
      input: route.capabilities.images ? ["text", "image"] : ["text"],
      cost,
      contextWindow: route.capabilities.contextWindow,
      maxTokens: Math.min(32_768, Math.max(4_096, Math.floor(route.capabilities.contextWindow / 4))),
      compat: provider.compat,
    }],
  };
}

/**
 * Preserve positive upstream response identity without patching Pi.
 *
 * Pi's OpenAI-compatible adapter records responseModel only when chunk.model
 * differs from Model.id. The delegate therefore receives an unrouteable
 * internal sentinel while the composed payload hook forces route.model onto
 * the wire. A conforming upstream response must differ from the sentinel, so
 * the adapter records its concrete model. Missing chunk.model stays missing
 * and is rejected by workerMessageIdentityError before any tool dispatch.
 */
export function createExactModelIdentityStream(
  delegate: OpenAICompatibleWorkerStream = builtInOpenAICompatibleStream,
): NonNullable<ProviderConfig["streamSimple"]> {
  return (model, context, options) => {
    const route = resolveModelRoute({ provider: model.provider, model: model.id });
    if (!route) {
      throw new Error("pi_worker_policy_failure:request_context_model_mismatch");
    }

    const sentinel = `__pi_exact_response_identity_${randomBytes(16).toString("hex")}__`;
    const delegateModel = {
      ...model,
      api: "openai-completions" as const,
      id: sentinel,
      // Compatibility inference normally keys off the requested model id.
      // Preserve the one id-sensitive setting after replacing that id with the
      // internal sentinel; provider/base-URL-derived settings remain intact.
      compat: {
        ...model.compat,
        ...(route.provider === "openrouter" && route.model.startsWith("anthropic/")
          ? { cacheControlFormat: "anthropic" as const }
          : {}),
      },
    } as Model<"openai-completions">;
    const callerOnPayload = options?.onPayload;
    const callerOnResponse = options?.onResponse;
    const delegateOptions: SimpleStreamOptions = {
      ...options,
      onPayload: async (payload) => {
        const initial = exactWorkerRequestPayload(payload, route);
        if (!initial) throw new Error("pi_worker_policy_failure:invalid_provider_payload");
        const replacement = callerOnPayload
          ? await callerOnPayload(initial, model)
          : undefined;
        if (options?.signal?.aborted) {
          throw new Error("pi_worker_policy_failure:provider_request_aborted");
        }
        const exact = exactWorkerRequestPayload(replacement === undefined ? initial : replacement, route);
        if (!exact) throw new Error("pi_worker_policy_failure:invalid_provider_payload");
        return exact;
      },
      onResponse: callerOnResponse
        ? (response) => callerOnResponse(response, model)
        : undefined,
    };
    const mapped = createAssistantMessageEventStream();

    void (async () => {
      try {
        // Keep delegate construction inside the guarded task: missing auth and
        // other synchronous adapter failures must become a terminal stream
        // error instead of an unhandled extension exception.
        const delegateContext = remapContextForIdentitySentinel(context, model, delegateModel);
        const upstream = delegate(delegateModel, delegateContext, delegateOptions);
        for await (const event of upstream) {
          mapped.push(remapWorkerStreamEvent(event, model, route));
        }
        mapped.end();
      } catch (error) {
        const failed = failedWorkerMessage(model, route, error);
        mapped.push({ type: "error", reason: "error", error: failed });
        mapped.end();
      }
    })();

    return mapped;
  };
}

/**
 * The built-in adapter preserves signed/redacted reasoning and tool-call
 * signatures only when prior assistant messages match its model/api exactly.
 * Remap history from the public exact-identity API to the private sentinel so
 * a tool follow-up remains same-model inside the delegate. Cross-route history
 * stays untouched and therefore keeps Pi's normal cross-model sanitization.
 */
function remapContextForIdentitySentinel(
  context: Context,
  publicModel: Model<Api>,
  delegateModel: Model<"openai-completions">,
): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "assistant") return message;
      // Pi drops errored/aborted assistant records before replay. Leave those
      // incomplete records untouched; they do not carry a successful upstream
      // identity and must never be promoted to same-model signed history.
      if (message.stopReason === "error" || message.stopReason === "aborted") return message;
      const historicalRoute = resolveModelRoute({ provider: message.provider, model: message.model });
      if (!historicalRoute) {
        throw new Error("pi_worker_policy_failure:historical_response_route_unlisted");
      }
      if (!workerResponseMatchesRoute(historicalRoute, message.responseModel)) {
        throw new Error(message.responseModel === undefined
          ? "pi_worker_policy_failure:historical_response_identity_missing"
          : "pi_worker_policy_failure:historical_response_identity_mismatch");
      }
      if (message.provider !== publicModel.provider || message.model !== publicModel.id) return message;
      if (message.api !== publicModel.api && message.api !== "openai-completions") {
        throw new Error("pi_worker_policy_failure:historical_response_api_mismatch");
      }
      return {
        ...message,
        api: delegateModel.api,
        model: delegateModel.id,
      };
    }),
  };
}

/** Bind the generic exact-identity stream to the one route admitted in a worker. */
export function createExactIdentityWorkerStream(
  route: ResolvedModelRoute,
  delegate: OpenAICompatibleWorkerStream = builtInOpenAICompatibleStream,
): NonNullable<ProviderConfig["streamSimple"]> {
  const stream = createExactModelIdentityStream(delegate);
  return (model, context, options) => {
    if (model.provider !== route.provider || model.id !== route.model) {
      throw new Error("pi_worker_policy_failure:request_context_model_mismatch");
    }
    return stream(model, context, options);
  };
}

/**
 * Register the custom API handler for every exact coordinator provider.
 * Generated Pi models select EXACT_MODEL_IDENTITY_API; this call supplies the
 * one stream implementation without changing or expanding the model catalog.
 */
export function registerExactModelIdentityApi(pi: ExtensionAPI): void {
  const streamSimple = createExactModelIdentityStream();
  for (const provider of new Set(MODEL_ROSTER.profiles.map((profile) => profile.provider))) {
    pi.registerProvider(provider, {
      api: EXACT_MODEL_IDENTITY_API,
      streamSimple,
    });
  }
}

function remapWorkerStreamEvent(
  event: AssistantMessageEvent,
  model: Model<Api>,
  route: ResolvedModelRoute,
): AssistantMessageEvent {
  if ("partial" in event) {
    return { ...event, partial: remapWorkerMessage(event.partial, model, route) } as AssistantMessageEvent;
  }
  if (event.type === "done") {
    return { ...event, message: remapWorkerMessage(event.message, model, route) };
  }
  return { ...event, error: remapWorkerMessage(event.error, model, route) };
}

function remapWorkerMessage(
  message: AssistantMessage,
  model: Model<Api>,
  route: ResolvedModelRoute,
): AssistantMessage {
  return {
    ...message,
    api: model.api,
    provider: route.provider,
    model: route.model,
  };
}

function failedWorkerMessage(
  model: Model<Api>,
  route: ResolvedModelRoute,
  error: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: route.provider,
    model: route.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function exactWorkerRequestPayload(payload: unknown, route: ResolvedModelRoute): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const current = payload as Record<string, unknown>;
  return {
    ...current,
    model: route.model,
    ...(route.provider === "openrouter"
      ? {
          provider: {
            ...(isRecord(current.provider) ? current.provider : {}),
            allow_fallbacks: false,
          },
        }
      : {}),
  };
}

export function workerResponseMatchesRoute(route: ResolvedModelRoute, responseModel: unknown): boolean {
  return responseModelMatchesRoute(route, responseModel);
}

export function workerMessageIdentityError(
  route: ResolvedModelRoute,
  message: { provider?: unknown; model?: unknown; responseModel?: unknown },
): "response_runtime_identity_missing" | "response_runtime_identity_mismatch" | "response_model_identity_missing" | "response_model_identity_mismatch" | null {
  if (
    typeof message.provider !== "string" || message.provider.length === 0
    || typeof message.model !== "string" || message.model.length === 0
  ) {
    return "response_runtime_identity_missing";
  }
  if (message.provider !== route.provider || message.model !== route.model) {
    return "response_runtime_identity_mismatch";
  }
  if (message.responseModel === undefined) return "response_model_identity_missing";
  return workerResponseMatchesRoute(route, message.responseModel) ? null : "response_model_identity_mismatch";
}

export function registerWorkerExtension(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
  controls: WorkerExtensionControls = {},
): WorkerConfig {
  const config = loadWorkerConfig(env);
  let responseIdentityValidated = false;
  const failProcess = controls.failProcess ?? ((reason: string) => {
    process.exitCode = 78;
    console.error(`pi_worker_policy_failure:${reason}`);
  });

  // Replace the selected provider with one tracked endpoint and one tracked
  // model. The child does not need a user-owned Pi config directory.
  pi.registerProvider(config.route.provider, workerProviderConfig(config.route, env));

  const failClosed = (ctx: ExtensionContext, reason: string): void => {
    ctx.abort();
    failProcess(reason);
  };

  pi.on("before_provider_request", (event, ctx) => {
    if (!contextMatchesRoute(ctx, config.route)) {
      failClosed(ctx, "request_context_model_mismatch");
      return blockedPayload();
    }
    const payload = exactWorkerRequestPayload(event.payload, config.route);
    if (!payload) {
      failClosed(ctx, "invalid_provider_payload");
      return blockedPayload();
    }
    return payload;
  });

  pi.on("turn_start", () => {
    responseIdentityValidated = false;
  });

  // Pi emits assistant message_end before dispatching any tool calls. Validate
  // the upstream identity at that boundary so a substituted/missing model can
  // never exercise even the scoped worker tools.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const identityError = workerMessageIdentityError(config.route, event.message);
    responseIdentityValidated = identityError === null;
    if (identityError) {
      failClosed(ctx, identityError);
    }
  });

  pi.on("tool_call", () => responseIdentityValidated
    ? undefined
    : { block: true, reason: "worker response model identity was not positively validated" });

  registerReadTools(pi, config);
  if (config.mode === "isolated_worktree") registerWriteTools(pi, config);
  return config;
}

function registerReadTools(pi: ExtensionAPI, config: WorkerConfig): void {
  pi.registerTool({
    name: "read",
    label: "Scoped Read",
    description: `Read a repository file. Output is bounded to ${MAX_READ_BYTES} bytes and ${MAX_READ_LINES} lines.`,
    parameters: ReadParams,
    async execute(_id, params, signal, _update, ctx) {
      assertWorkerContext(config, ctx);
      throwIfAborted(signal);
      const normalized = normalizeWorkerPath(params.path, false);
      assertReadablePath(normalized);
      const absolute = resolveReadablePath(config, normalized, "file");
      const text = readTextBounded(absolute, MAX_MUTATION_BYTES);
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, Math.floor(params.offset ?? 1) - 1);
      const end = Math.min(lines.length, start + Math.min(Math.floor(params.limit ?? MAX_READ_LINES), MAX_READ_LINES));
      const limited = truncateUtf8(lines.slice(start, end).join("\n"), MAX_READ_BYTES);
      return toolResult(scrubWorkerText(limited.text), {
        path: normalized,
        bytes: limited.bytes,
        truncated: limited.truncated || end < lines.length,
      });
    },
  });

  pi.registerTool({
    name: "grep",
    label: "Scoped Grep",
    description: "Search bounded repository text using a fixed string; no shell or subprocess is used.",
    parameters: GrepParams,
    async execute(_id, params, signal, _update, ctx) {
      assertWorkerContext(config, ctx);
      throwIfAborted(signal);
      const startPath = normalizeWorkerPath(params.path ?? ".", true);
      const maxResults = Math.min(Math.floor(params.maxResults ?? 100), MAX_RESULTS);
      const fileGlob = params.glob ? compileGlob(normalizeRepoPath(params.glob)) : null;
      const files = collectFiles(config, startPath, signal);
      const needle = params.ignoreCase ? params.pattern.toLocaleLowerCase("en-US") : params.pattern;
      const matches: string[] = [];
      let scannedBytes = 0;
      for (const file of files) {
        if (matches.length >= maxResults || scannedBytes >= MAX_SCAN_BYTES) break;
        if (fileGlob && !fileGlob.test(file.relative)) continue;
        if (isSensitiveReadPath(file.relative)) continue;
        const budget = Math.min(MAX_MUTATION_BYTES, MAX_SCAN_BYTES - scannedBytes);
        if (budget <= 0) break;
        let text: string;
        try { text = readTextBounded(file.absolute, budget); }
        catch { continue; }
        scannedBytes += Buffer.byteLength(text);
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
          const haystack = params.ignoreCase ? lines[index].toLocaleLowerCase("en-US") : lines[index];
          if (haystack.includes(needle)) matches.push(`${file.relative}:${index + 1}:${lines[index]}`);
        }
      }
      const limited = truncateUtf8(matches.join("\n"), MAX_READ_BYTES);
      return toolResult(scrubWorkerText(limited.text), {
        path: startPath,
        matches: matches.length,
        scannedFiles: files.length,
        scannedBytes,
        truncated: limited.truncated || matches.length >= maxResults || scannedBytes >= MAX_SCAN_BYTES,
      });
    },
  });

  pi.registerTool({
    name: "find",
    label: "Scoped Find",
    description: "Find repository-relative file names with bounded traversal; symlinks are never followed.",
    parameters: FindParams,
    async execute(_id, params, signal, _update, ctx) {
      assertWorkerContext(config, ctx);
      throwIfAborted(signal);
      const startPath = normalizeWorkerPath(params.path ?? ".", true);
      const matcher = compileGlob(normalizeRepoPath(params.pattern));
      const maxResults = Math.min(Math.floor(params.maxResults ?? 100), MAX_RESULTS);
      const matches = collectFiles(config, startPath, signal)
        .map((entry) => entry.relative)
        .filter((relative) => matcher.test(relative))
        .slice(0, maxResults);
      return toolResult(matches.join("\n"), { path: startPath, matches: matches.length });
    },
  });

  pi.registerTool({
    name: "ls",
    label: "Scoped List",
    description: "List one repository directory without following symlinks.",
    parameters: LsParams,
    async execute(_id, params, signal, _update, ctx) {
      assertWorkerContext(config, ctx);
      throwIfAborted(signal);
      const requested = normalizeWorkerPath(params.path ?? ".", true);
      const absolute = resolveReadablePath(config, requested, "directory");
      const limit = Math.min(Math.floor(params.limit ?? 200), MAX_RESULTS);
      const entries = fs.readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, limit)
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`);
      return toolResult(entries.join("\n"), { path: requested, entries: entries.length });
    },
  });
}

function registerWriteTools(pi: ExtensionAPI, config: WorkerConfig): void {
  pi.registerTool({
    name: "write",
    label: "Scoped Write",
    description: "Atomically write one assigned repository-relative file. No shell is available.",
    parameters: WriteParams,
    async execute(_id, params, signal, _update, ctx) {
      assertWorkerContext(config, ctx);
      throwIfAborted(signal);
      const normalized = assertWritablePath(config, params.path);
      assertMutationSize(params.content);
      const target = resolveMutationPath(config, normalized, true);
      atomicWrite(target, params.content);
      throwIfAborted(signal);
      return toolResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${normalized}`, {
        path: normalized,
        bytes: Buffer.byteLength(params.content),
      });
    },
  });

  pi.registerTool({
    name: "edit",
    label: "Scoped Edit",
    description: "Replace exactly one occurrence in one assigned repository file. No shell is available.",
    parameters: EditParams,
    async execute(_id, params, signal, _update, ctx) {
      assertWorkerContext(config, ctx);
      throwIfAborted(signal);
      const normalized = assertWritablePath(config, params.path);
      const target = resolveMutationPath(config, normalized, false);
      const current = readTextBounded(target, MAX_MUTATION_BYTES);
      const first = current.indexOf(params.oldText);
      if (first < 0) throw new Error(`Edit text was not found in ${normalized}.`);
      if (current.indexOf(params.oldText, first + params.oldText.length) >= 0) {
        throw new Error(`Edit text is not unique in ${normalized}.`);
      }
      const next = `${current.slice(0, first)}${params.newText}${current.slice(first + params.oldText.length)}`;
      assertMutationSize(next);
      atomicWrite(target, next);
      throwIfAborted(signal);
      return toolResult(`Edited ${normalized}`, { path: normalized, bytes: Buffer.byteLength(next) });
    },
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required worker environment variable: ${key}`);
  return value;
}

function contextMatchesRoute(ctx: ExtensionContext, route: ResolvedModelRoute): boolean {
  return ctx.model?.provider === route.provider && ctx.model.id === route.model;
}

function blockedPayload(): Record<string, unknown> {
  return { model: "__PI_ITERATIVE_GOAL_WORKER_BLOCKED__", messages: [] };
}

function assertWorkerContext(config: WorkerConfig, ctx: Pick<ExtensionContext, "cwd">): void {
  let actual: string;
  try { actual = fs.realpathSync(ctx.cwd); }
  catch { throw new Error("Worker cwd is unavailable."); }
  if (actual !== config.rootReal) throw new Error("Worker cwd does not match its assigned root.");
}

function normalizeWorkerPath(raw: string, allowRoot: boolean): string {
  const trimmed = raw.trim();
  if (allowRoot && (trimmed === "" || trimmed === "." || trimmed === "./")) return ".";
  return normalizeRepoPath(raw);
}

function resolveReadablePath(config: WorkerConfig, requested: string, expected: "file" | "directory"): string {
  const absolute = requested === "." ? config.rootReal : resolveContainedPath(config.rootReal, requested);
  if (!fs.existsSync(absolute)) throw new Error(`Path does not exist: ${requested}`);
  const stat = fs.statSync(absolute);
  if (expected === "file" && !stat.isFile()) throw new Error(`Not a file: ${requested}`);
  if (expected === "directory" && !stat.isDirectory()) throw new Error(`Not a directory: ${requested}`);
  return absolute;
}

function assertReadablePath(relative: string): void {
  if (isSensitiveReadPath(relative)) throw new Error(`Sensitive control/credential path is not readable by workers: ${relative}`);
}

function isSensitiveReadPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (normalized === ".git" || normalized.startsWith(".git/")) return true;
  if (normalized === ".pi/iterative-goal/managed" || normalized.startsWith(".pi/iterative-goal/managed/")) return true;
  if (normalized === ".pi/iterative-goal/runtime" || normalized.startsWith(".pi/iterative-goal/runtime/")) return true;
  if (BLOCKED_READ_BASENAMES.has(base)) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(base)) return true;
  if (/(?:^|[-_.])(?:private[-_.]?key|service[-_.]?account)(?:[-_.]|$)/i.test(base)) return true;
  return /^\.env(?:\..+)?$/.test(base) && base !== ".env.example";
}

function scrubWorkerText(text: string): string {
  return dlpScrubText(text, defaultDlpState()).text;
}

function assertWritablePath(config: WorkerConfig, raw: string): string {
  const normalized = normalizeWorkerPath(raw, false);
  if (normalized === ".git" || normalized.startsWith(".git/")) throw new Error("Worker mutations may not target .git.");
  if (normalized === ".pi/iterative-goal/managed" || normalized.startsWith(".pi/iterative-goal/managed/")) {
    throw new Error("Worker mutations may not target managed control-plane state.");
  }
  if (!pathInScopes(normalized, config.allowedScopes)) {
    throw new Error(`Worker mutation is outside assigned paths: ${normalized}`);
  }
  return normalized;
}

function resolveMutationPath(config: WorkerConfig, normalized: string, createParents: boolean): string {
  const components = normalized.split("/");
  const filename = components.pop();
  if (!filename) throw new Error(`Invalid mutation path: ${normalized}`);
  let current = config.rootReal;
  for (const component of components) {
    const next = path.join(current, component);
    if (!fs.existsSync(next)) {
      if (!createParents) throw new Error(`Parent directory does not exist: ${component}`);
      fs.mkdirSync(next, { mode: 0o700 });
    }
    const stat = fs.lstatSync(next);
    if (stat.isSymbolicLink()) throw new Error(`Worker mutation path traverses a symlink: ${normalized}`);
    if (!stat.isDirectory()) throw new Error(`Worker mutation parent is not a directory: ${normalized}`);
    current = next;
  }
  const target = path.join(current, filename);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Worker mutation target is a symlink: ${normalized}`);
    if (!stat.isFile()) throw new Error(`Worker mutation target is not a file: ${normalized}`);
  } else if (!createParents) {
    throw new Error(`Worker mutation target does not exist: ${normalized}`);
  }
  const relative = path.relative(config.rootReal, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Worker mutation escapes its assigned root: ${normalized}`);
  }
  return target;
}

function atomicWrite(target: string, content: string): void {
  const existingMode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: existingMode });
    fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort for private temp */ }
  }
}

function collectFiles(
  config: WorkerConfig,
  startPath: string,
  signal: AbortSignal | undefined,
): Array<{ relative: string; absolute: string }> {
  const absoluteStart = resolveReadablePath(config, startPath, fs.statSync(startPath === "." ? config.rootReal : resolveContainedPath(config.rootReal, startPath)).isDirectory() ? "directory" : "file");
  const collected: Array<{ relative: string; absolute: string }> = [];
  const visit = (absolute: string): void => {
    if (collected.length >= MAX_SCAN_FILES) return;
    throwIfAborted(signal);
    const lstat = fs.lstatSync(absolute);
    if (lstat.isSymbolicLink()) return;
    if (lstat.isFile()) {
      collected.push({
        relative: path.relative(config.rootReal, absolute).replace(/\\/g, "/"),
        absolute,
      });
      return;
    }
    if (!lstat.isDirectory()) return;
    if (absolute !== config.rootReal && SKIPPED_SCAN_DIRS.has(path.basename(absolute))) return;
    for (const entry of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, entry));
      if (collected.length >= MAX_SCAN_FILES) break;
    }
  };
  visit(absoluteStart);
  return collected;
}

function compileGlob(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function readTextBounded(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds worker read bound (${maxBytes} bytes): ${filePath}`);
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) throw new Error(`Binary files are not readable by workers: ${filePath}`);
  return buffer.toString("utf8");
}

function truncateUtf8(text: string, maximum: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= maximum) return { text, bytes: buffer.length, truncated: false };
  const truncated = buffer.subarray(0, maximum).toString("utf8");
  return { text: truncated, bytes: Buffer.byteLength(truncated), truncated: true };
}

function assertMutationSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_MUTATION_BYTES) {
    throw new Error(`Worker mutation exceeds ${MAX_MUTATION_BYTES} bytes.`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Worker tool call was aborted.");
}

function toolResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function workerExtension(pi: ExtensionAPI): void {
  registerWorkerExtension(pi);
}
