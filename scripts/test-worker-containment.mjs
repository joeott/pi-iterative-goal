#!/usr/bin/env node
/** Offline adversarial coverage for the production worker capability surface. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const worker = await import("../dist/worker-extension.js");
const poolModule = await import("../dist/agents/pool.js");
const roster = await import("../dist/domain/model-roster.js");

function makeFakePi() {
  const tools = new Map();
  const hooks = new Map();
  const providers = [];
  return {
    tools,
    hooks,
    providers,
    api: {
      registerTool(tool) { tools.set(tool.name, tool); },
      registerProvider(name, config) { providers.push({ name, config }); },
      on(name, handler) { hooks.set(name, handler); },
    },
  };
}

function workerEnv(root, mode, profile, allowedPaths, credential = {}) {
  return {
    ...credential,
    [worker.WORKER_ENV.root]: root,
    [worker.WORKER_ENV.mode]: mode,
    [worker.WORKER_ENV.allowedPaths]: worker.encodeWorkerAllowedPaths(allowedPaths),
    [worker.WORKER_ENV.modelProfile]: profile,
  };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-worker-containment-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-worker-outside-"));
try {
  fs.mkdirSync(path.join(scratch, "src"));
  fs.writeFileSync(path.join(scratch, "src", "allowed.txt"), "alpha\nneedle\n");
  fs.writeFileSync(path.join(scratch, "src", "other.txt"), "other\n");
  fs.writeFileSync(path.join(scratch, "src", "credential.txt"), `token ghp_${"A".repeat(40)}\n`);
  fs.writeFileSync(path.join(scratch, ".env"), "CEREBRAS_API_KEY=must-not-read\n");
  fs.writeFileSync(path.join(scratch, ".git-credentials"), "https://user:secret@example.invalid\n");
  fs.writeFileSync(path.join(scratch, "private.pem"), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(scratch, "src", "escape-link"));
  fs.symlinkSync(outside, path.join(scratch, "src", "escape-dir"));

  const fake = makeFakePi();
  const failures = [];
  worker.registerWorkerExtension(
    fake.api,
    workerEnv(
      scratch,
      "isolated_worktree",
      "cerebras_gemma_4_31b",
      ["src/allowed.txt", "src/new/**", "src/escape-dir/**"],
      { CEREBRAS_API_KEY: "test-cerebras-credential" },
    ),
    { failProcess: (reason) => failures.push(reason) },
  );

  assert.deepEqual([...fake.tools.keys()].sort(), ["edit", "find", "grep", "ls", "read", "write"]);
  assert.equal(fake.providers.length, 1);
  assert.equal(fake.providers[0].name, "cerebras");
  assert.equal(fake.providers[0].config.api, "pi-iterative-goal-exact-openai-completions");
  assert.equal(typeof fake.providers[0].config.streamSimple, "function", "worker provider installs the exact-identity stream wrapper");
  assert.equal(fake.providers[0].config.apiKey, "test-cerebras-credential", "provider receives the selected credential value, not its env-var name");
  const signal = new AbortController().signal;
  const ctx = { cwd: scratch };

  const read = await fake.tools.get("read").execute("read", { path: "src/allowed.txt" }, signal, undefined, ctx);
  assert.match(read.content[0].text, /needle/);
  const scrubbed = await fake.tools.get("read").execute("read-secret-pattern", { path: "src/credential.txt" }, signal, undefined, ctx);
  assert.doesNotMatch(scrubbed.content[0].text, /ghp_/);
  assert.match(scrubbed.content[0].text, /REDACTED_SECRET_REF/);
  await assert.rejects(
    fake.tools.get("read").execute("read-env", { path: ".env" }, signal, undefined, ctx),
    /Sensitive control\/credential path/,
  );
  await assert.rejects(
    fake.tools.get("read").execute("read-git-credential", { path: ".git-credentials" }, signal, undefined, ctx),
    /Sensitive control\/credential path/,
  );
  await assert.rejects(
    fake.tools.get("read").execute("read-private-key", { path: "private.pem" }, signal, undefined, ctx),
    /Sensitive control\/credential path/,
  );
  await assert.rejects(
    fake.tools.get("read").execute("read-absolute", { path: path.join(outside, "secret.txt") }, signal, undefined, ctx),
    /repository-relative/,
  );
  await assert.rejects(
    fake.tools.get("read").execute("read-parent", { path: "../secret.txt" }, signal, undefined, ctx),
    /escapes repository root/,
  );
  await assert.rejects(
    fake.tools.get("read").execute("read-symlink", { path: "src/escape-link" }, signal, undefined, ctx),
    /escapes repository root through symlink/,
  );

  await fake.tools.get("edit").execute(
    "edit",
    { path: "src/allowed.txt", oldText: "alpha", newText: "beta" },
    signal,
    undefined,
    ctx,
  );
  assert.match(fs.readFileSync(path.join(scratch, "src", "allowed.txt"), "utf8"), /^beta/);
  await fake.tools.get("write").execute(
    "write",
    { path: "src/new/nested.txt", content: "bounded\n" },
    signal,
    undefined,
    ctx,
  );
  assert.equal(fs.readFileSync(path.join(scratch, "src", "new", "nested.txt"), "utf8"), "bounded\n");
  await assert.rejects(
    fake.tools.get("write").execute("write-outside", { path: "src/other.txt", content: "denied" }, signal, undefined, ctx),
    /outside assigned paths/,
  );
  await assert.rejects(
    fake.tools.get("write").execute("write-symlink", { path: "src/escape-dir/stolen.txt", content: "denied" }, signal, undefined, ctx),
    /symlink/,
  );
  assert.equal(fs.existsSync(path.join(outside, "stolen.txt")), false);

  const route = roster.requireModelRoute("cerebras_gemma_4_31b");
  let aborted = false;
  const providerCtx = {
    cwd: scratch,
    model: { provider: route.provider, id: route.model },
    abort() { aborted = true; },
  };
  const exactPayload = fake.hooks.get("before_provider_request")({ payload: { model: "substitute", messages: [] } }, providerCtx);
  assert.equal(exactPayload.model, route.model);
  assert.equal(aborted, false);
  fake.hooks.get("turn_start")({ turnIndex: 0, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({
    message: { role: "assistant", provider: route.provider, model: route.model, responseModel: "wrong-model" },
  }, providerCtx);
  assert.equal(aborted, true, "response substitution aborts the worker");
  assert.deepEqual(failures, ["response_model_identity_mismatch"]);
  assert.equal(fake.hooks.get("tool_call")({ toolName: "read", input: { path: "src/allowed.txt" } }, providerCtx).block, true);

  aborted = false;
  fake.hooks.get("turn_start")({ turnIndex: 1, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({
    message: { role: "assistant", provider: route.provider, model: route.model },
  }, providerCtx);
  assert.equal(aborted, true, "missing upstream response identity aborts before worker tool dispatch");
  assert.equal(failures.at(-1), "response_model_identity_missing");
  assert.equal(fake.hooks.get("tool_call")({ toolName: "read", input: { path: "src/allowed.txt" } }, providerCtx).block, true);

  aborted = false;
  fake.hooks.get("turn_start")({ turnIndex: 2, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({
    message: { role: "assistant", provider: route.provider, model: route.model, responseModel: route.model },
  }, providerCtx);
  assert.equal(aborted, false);
  assert.equal(fake.hooks.get("tool_call")({ toolName: "read", input: { path: "src/allowed.txt" } }, providerCtx), undefined);

  aborted = false;
  fake.hooks.get("turn_start")({ turnIndex: 3, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({ message: { role: "assistant", model: route.model } }, providerCtx);
  assert.equal(aborted, true, "missing runtime provider identity aborts before worker tool dispatch");
  assert.equal(failures.at(-1), "response_runtime_identity_missing");

  aborted = false;
  fake.hooks.get("turn_start")({ turnIndex: 4, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({
    message: { role: "assistant", provider: "openrouter", model: route.model },
  }, providerCtx);
  assert.equal(aborted, true, "runtime provider substitution aborts before worker tool dispatch");
  assert.equal(failures.at(-1), "response_runtime_identity_mismatch");

  const openRouter = roster.requireModelRoute("openrouter_kimi_k3");
  const openRouterPayload = worker.exactWorkerRequestPayload({ model: "other", provider: { order: ["x"] } }, openRouter);
  assert.equal(openRouterPayload.model, openRouter.model);
  assert.equal(openRouterPayload.provider.allow_fallbacks, false);
  assert.equal(worker.workerResponseMatchesRoute(openRouter, undefined), false, "missing provider identity fails closed");
  assert.equal(
    worker.workerResponseMatchesRoute(
      roster.requireModelRoute("fireworks_glm_5_2_fast"),
      "accounts/fireworks/models/glm-5p2",
    ),
    true,
    "the verified Fireworks fast backing-model identity is the sole substitution mapping",
  );

  const streamRoute = roster.requireModelRoute("cerebras_gpt_oss_120b");
  let delegateModel = null;
  let delegateContext = null;
  let outboundPayload = null;
  const identityDelegate = (model, context, options) => {
    delegateModel = model;
    delegateContext = context;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      outboundPayload = await options.onPayload({ model: model.id, messages: [] }, model);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "exact" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseModel: outboundPayload.model,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    })();
    return stream;
  };
  const exactStream = worker.createExactIdentityWorkerStream(streamRoute, identityDelegate);
  const exactOuterModel = {
    id: streamRoute.model,
    name: streamRoute.model,
    api: "pi-iterative-goal-exact-openai-completions",
    provider: streamRoute.provider,
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const priorAssistant = {
    role: "assistant",
    api: exactOuterModel.api,
    provider: exactOuterModel.provider,
    model: exactOuterModel.id,
    responseModel: streamRoute.model,
    content: [
      { type: "thinking", thinking: "signed", thinkingSignature: "reasoning_content" },
      { type: "toolCall", id: "signed-call", name: "read", arguments: { path: "tracked.txt" }, thoughtSignature: "signed-tool" },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  const foreignRoute = roster.requireModelRoute("openrouter_kimi_k3");
  const foreignAssistant = {
    ...priorAssistant,
    api: exactOuterModel.api,
    provider: foreignRoute.provider,
    model: foreignRoute.model,
    responseModel: foreignRoute.model,
    content: [{ type: "text", text: "other exact route" }],
    stopReason: "stop",
  };
  const mappedMessage = await exactStream(exactOuterModel, {
    messages: [
      priorAssistant,
      {
        role: "toolResult",
        toolCallId: "signed-call",
        toolName: "read",
        content: [{ type: "text", text: "tracked" }],
        isError: false,
        timestamp: Date.now(),
      },
      foreignAssistant,
    ],
  }, { apiKey: "test" }).result();
  assert.notEqual(delegateModel.id, streamRoute.model, "delegate sees only an internal response-identity sentinel");
  assert.match(delegateModel.id, /^__pi_exact_response_identity_[0-9a-f]{32}__$/);
  assert.equal(delegateContext.messages[0].api, "openai-completions");
  assert.equal(delegateContext.messages[0].model, delegateModel.id, "same-route history follows the private sentinel");
  assert.equal(delegateContext.messages[0].content[0].thinkingSignature, "reasoning_content", "signed thinking survives same-model replay");
  assert.equal(delegateContext.messages[0].content[1].thoughtSignature, "signed-tool", "signed tool calls survive same-model replay");
  assert.equal(delegateContext.messages[1].toolCallId, "signed-call", "tool-result identity remains paired with replayed history");
  assert.equal(delegateContext.messages[2], foreignAssistant, "another verified roster route remains cross-model");
  assert.equal(priorAssistant.api, exactOuterModel.api, "history remapping never mutates the public session record");
  assert.equal(priorAssistant.model, streamRoute.model);
  assert.equal(outboundPayload.model, streamRoute.model, "the wire payload is forced back to the exact roster model");
  assert.equal(mappedMessage.model, streamRoute.model, "the internal sentinel never escapes into Pi messages");
  assert.equal(mappedMessage.responseModel, streamRoute.model, "same-model upstream identity remains explicit");

  let rejectedHistoryDelegateCalled = false;
  const rejectedHistoryStream = worker.createExactIdentityWorkerStream(streamRoute, () => {
    rejectedHistoryDelegateCalled = true;
    throw new Error("delegate must not receive unverified history");
  });
  const rejectedHistoryMessage = await rejectedHistoryStream(exactOuterModel, {
    messages: [{ ...priorAssistant, responseModel: undefined }],
  }, { apiKey: "test" }).result();
  assert.equal(rejectedHistoryDelegateCalled, false);
  assert.equal(rejectedHistoryMessage.stopReason, "error");
  assert.match(rejectedHistoryMessage.errorMessage, /historical_response_identity_missing/);

  const sonnetRoute = roster.requireModelRoute("openrouter_claude_sonnet_5");
  let sonnetDelegateModel = null;
  const sonnetIdentityStream = worker.createExactModelIdentityStream((model) => {
    sonnetDelegateModel = model;
    const stream = createAssistantMessageEventStream();
    const message = {
      ...priorAssistant,
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseModel: sonnetRoute.model,
      content: [{ type: "text", text: "exact" }],
      stopReason: "stop",
    };
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  });
  await sonnetIdentityStream({
    ...exactOuterModel,
    id: sonnetRoute.model,
    name: sonnetRoute.model,
    provider: sonnetRoute.provider,
  }, { messages: [] }, { apiKey: "test" }).result();
  assert.equal(sonnetDelegateModel.compat.cacheControlFormat, "anthropic", "sentinel preserves OpenRouter Anthropic cache controls");

  const kimiRoute = roster.requireModelRoute("openrouter_kimi_k3");
  let kimiDelegateModel = null;
  const kimiIdentityStream = worker.createExactModelIdentityStream((model) => {
    kimiDelegateModel = model;
    const stream = createAssistantMessageEventStream();
    const message = {
      ...priorAssistant,
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseModel: kimiRoute.model,
      content: [{ type: "text", text: "exact" }],
      stopReason: "stop",
    };
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  });
  await kimiIdentityStream({
    ...exactOuterModel,
    id: kimiRoute.model,
    name: kimiRoute.model,
    provider: kimiRoute.provider,
  }, { messages: [] }, { apiKey: "test" }).result();
  assert.equal(kimiDelegateModel.compat.cacheControlFormat, undefined, "Kimi does not inherit Anthropic cache controls");

  const throwingStream = worker.createExactModelIdentityStream(() => {
    throw new Error("synchronous delegate failure");
  });
  const throwingMessage = await throwingStream(exactOuterModel, { messages: [] }, { apiKey: "test" }).result();
  assert.equal(throwingMessage.stopReason, "error");
  assert.match(throwingMessage.errorMessage, /synchronous delegate failure/);

  const coordinatorProviders = makeFakePi();
  worker.registerExactModelIdentityApi(coordinatorProviders.api);
  assert.deepEqual(
    coordinatorProviders.providers.map(({ name }) => name).sort(),
    ["cerebras", "fireworks", "openrouter", "zai"],
  );
  assert(coordinatorProviders.providers.every(({ config }) => (
    config.api === "pi-iterative-goal-exact-openai-completions"
    && typeof config.streamSimple === "function"
    && config.models === undefined
  )), "coordinator identity registration supplies one custom API without expanding the roster");

  const readOnly = makeFakePi();
  worker.registerWorkerExtension(
    readOnly.api,
    workerEnv(scratch, "read_only_snapshot", "cerebras_gpt_oss_120b", [], { CEREBRAS_API_KEY: "test" }),
    { failProcess() {} },
  );
  assert.deepEqual([...readOnly.tools.keys()].sort(), ["find", "grep", "ls", "read"], "read-only workers receive no mutator or process tool");

  const args = poolModule.buildPiSubprocessArgs(poolModule.createAgentTask("Implementer", "edit", {
    workspace: "isolated_worktree",
    allowedPaths: ["src/allowed.txt"],
  }));
  assert(args.includes("--no-builtin-tools"));
  assert(args.includes("--no-extensions"));
  assert.equal(args.filter((arg) => arg === "--extension").length, 1, "one explicit worker extension is loaded");
  assert.equal(args[args.indexOf("--extension") + 1], poolModule.resolveWorkerExtensionPath());
  assert.equal(args.some((arg) => /bash/.test(arg)), false, "worker launch has no shell tool");
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,edit,write");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-worker-snapshot-repo-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "worker-test@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Worker Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".env"), "CEREBRAS_API_KEY=untracked-secret\n");

    let spawned = null;
    const spawnImpl = (command, childArgs, options) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      spawned = { command, childArgs, options, proc };
      return proc;
    };
    const subprocessPool = new poolModule.PiSubprocessAgentPool(repo, { spawnImpl });
    const scout = poolModule.createAgentTask("Scout", "inspect", {
      id: "contained-reader",
      modelProfile: "cerebras_gpt_oss_120b",
      budget: { maxTurns: 2, maxTokens: 100, timeoutMs: 10_000 },
    });
    const previousCerebras = process.env.CEREBRAS_API_KEY;
    const previousOpenRouter = process.env.OPENROUTER_API_KEY;
    process.env.CEREBRAS_API_KEY = "selected-route-secret";
    process.env.OPENROUTER_API_KEY = "unrelated-secret";
    const resultPromise = subprocessPool.submit(scout);
    assert(spawned, "reader subprocess was admitted");
    assert.notEqual(fs.realpathSync(spawned.options.cwd), fs.realpathSync(repo));
    assert.equal(fs.existsSync(path.join(spawned.options.cwd, ".env")), false, "untracked source secrets are absent from the reader snapshot");
    assert.equal(spawned.options.env.CEREBRAS_API_KEY, "selected-route-secret");
    assert.equal(spawned.options.env.OPENROUTER_API_KEY, undefined, "unrelated provider credentials are stripped");
    assert.notEqual(spawned.options.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR, "worker uses a private empty Pi config root");
    spawned.proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "cerebras",
        model: "gpt-oss-120b",
        responseModel: "gpt-oss-120b",
        stopReason: "stop",
        content: [{ type: "text", text: "contained" }],
        usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    })}\n`));
    spawned.proc.emit("close", 0);
    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.outputText, "contained");
    assert.equal(fs.existsSync(spawned.options.cwd), false, "reader snapshot is cleaned after process close");
    assert.equal(fs.existsSync(spawned.options.env.PI_CODING_AGENT_DIR), false, "private Pi runtime is cleaned after process close");
    if (previousCerebras === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousCerebras;
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log("worker-containment: PASS (scoped custom tools, exact model, selected credential, tracked snapshots, no shell)");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
