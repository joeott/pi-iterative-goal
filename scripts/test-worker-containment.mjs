#!/usr/bin/env node
/** Offline adversarial coverage for the production worker capability surface. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    message: { role: "assistant", model: route.model, responseModel: "wrong-model" },
  }, providerCtx);
  assert.equal(aborted, true, "response substitution aborts the worker");
  assert.deepEqual(failures, ["response_model_identity_mismatch"]);
  assert.equal(fake.hooks.get("tool_call")({ toolName: "read", input: { path: "src/allowed.txt" } }, providerCtx).block, true);

  aborted = false;
  fake.hooks.get("turn_start")({ turnIndex: 1, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({ message: { role: "assistant", model: route.model } }, providerCtx);
  assert.equal(aborted, true, "missing response identity aborts before worker tool dispatch");
  assert.deepEqual(failures, ["response_model_identity_mismatch", "response_model_identity_missing"]);

  aborted = false;
  fake.hooks.get("turn_start")({ turnIndex: 2, timestamp: Date.now() }, providerCtx);
  fake.hooks.get("message_end")({
    message: { role: "assistant", model: route.model, responseModel: route.model },
  }, providerCtx);
  assert.equal(aborted, false);
  assert.equal(fake.hooks.get("tool_call")({ toolName: "read", input: { path: "src/allowed.txt" } }, providerCtx), undefined);

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
