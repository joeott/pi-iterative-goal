#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_CREDENTIALS,
  EXPECTED_PROFILES,
  REPOSITORY_ROOT,
  createOpenCodeConfig,
  createPiFiles,
  equalJson,
  loadRoster,
  materializeRuntime,
} from "./lib/model-runtime.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-runtime-test-"));
try {
  const piDir = path.join(temporaryRoot, "pi-agent");
  const openCodePath = path.join(temporaryRoot, "opencode.json");
  const evidencePath = path.join(temporaryRoot, "offline-probe.json");
  const roster = loadRoster();
  const expectedSelections = roster.profiles.map((profile) => `${profile.provider}/${profile.model}`);
  assert.equal(roster.profiles.length, 9);
  assert.deepEqual(roster.profiles.map((profile) => profile.id), Object.keys(EXPECTED_PROFILES));

  const piFiles = createPiFiles(roster, piDir);
  assert.deepEqual(piFiles["settings.json"].enabledModels, expectedSelections);
  assert.deepEqual(piFiles["settings.json"].packages, []);
  assert.equal(piFiles["settings.json"].extensions.length, 1);
  assert.doesNotMatch(piFiles["settings.json"].extensions[0], /langfuse/i);
  const piSelections = Object.entries(piFiles["models.json"].providers)
    .flatMap(([provider, config]) => config.models.map((model) => `${provider}/${model.id}`));
  assert.deepEqual(piSelections.sort(), [...expectedSelections].sort());
  assert.deepEqual(
    [...new Set(Object.values(piFiles["models.json"].providers).map((provider) => provider.apiKey))].sort(),
    [...ALLOWED_CREDENTIALS].sort(),
  );

  const expectedOpenCode = createOpenCodeConfig(roster);
  assert.deepEqual(expectedOpenCode.enabled_providers, ["zai", "fireworks", "openrouter", "cerebras"]);
  const openCodeSelections = Object.entries(expectedOpenCode.provider)
    .flatMap(([provider, config]) => Object.keys(config.models).map((model) => `${provider}/${model}`));
  assert.deepEqual(openCodeSelections.sort(), [...expectedSelections].sort());
  assert.equal(
    expectedOpenCode.provider.fireworks.models["accounts/fireworks/models/glm-5p2"].options.reasoningEffort,
    "max",
  );
  assert.equal(
    expectedOpenCode.provider.openrouter.models["moonshotai/kimi-k3"].options.provider.allow_fallbacks,
    false,
  );
  const openCodeCredentialRefs = Object.values(expectedOpenCode.provider).map((provider) => provider.options.apiKey);
  assert.deepEqual(
    openCodeCredentialRefs.sort(),
    ALLOWED_CREDENTIALS.map((name) => `{env:${name}}`).sort(),
  );

  const markerSecrets = Object.fromEntries(ALLOWED_CREDENTIALS.map((name) => [name, `test-secret-marker-${name}`]));
  const previousSecrets = Object.fromEntries(ALLOWED_CREDENTIALS.map((name) => [name, process.env[name]]));
  Object.assign(process.env, markerSecrets);
  materializeRuntime({ roster, piDir, openCodeOutput: openCodePath });
  for (const name of ALLOWED_CREDENTIALS) {
    if (previousSecrets[name] === undefined) delete process.env[name];
    else process.env[name] = previousSecrets[name];
  }
  const materialized = [
    fs.readFileSync(path.join(piDir, "settings.json"), "utf8"),
    fs.readFileSync(path.join(piDir, "models.json"), "utf8"),
    fs.readFileSync(openCodePath, "utf8"),
  ].join("\n");
  for (const secret of Object.values(markerSecrets)) assert.equal(materialized.includes(secret), false);
  if (process.platform !== "win32") {
    for (const filePath of [path.join(piDir, "settings.json"), path.join(piDir, "models.json"), openCodePath]) {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    }
  }

  const trackedOpenCode = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, ".opencode", "opencode.json"), "utf8"));
  assert.equal(equalJson(trackedOpenCode, expectedOpenCode), true, "tracked OpenCode config must match the roster generator");

  const offline = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts", "model-roster-probe.mjs"),
    "--output", evidencePath,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...markerSecrets },
  });
  assert.equal(offline.status, 0, offline.stderr || offline.stdout);
  const evidenceBytes = fs.readFileSync(evidencePath, "utf8");
  const evidence = JSON.parse(evidenceBytes);
  assert.equal(evidence.live, false);
  assert.equal(evidence.networkCallsPermitted, false);
  assert.equal(evidence.results.length, 9);
  assert.equal(evidence.summary.notRun, 45);
  for (const secret of Object.values(markerSecrets)) assert.equal(evidenceBytes.includes(secret), false);

  const launchedPiDir = path.join(temporaryRoot, "launcher-pi-agent");
  const launcherRun = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts", "run-goal-runtime.mjs"),
    "--materialize-only", "--pi-dir", launchedPiDir,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...markerSecrets, ANTHROPIC_API_KEY: "disallowed-provider-secret-marker" },
  });
  assert.equal(launcherRun.status, 0, launcherRun.stderr || launcherRun.stdout);
  assert.match(launcherRun.stdout, /launch: SKIPPED \(--materialize-only\)/);
  assert.equal(launcherRun.stdout.includes("disallowed-provider-secret-marker"), false);
  assert.equal(fs.existsSync(path.join(launchedPiDir, "settings.json")), true);
  assert.equal(fs.existsSync(path.join(launchedPiDir, "models.json")), true);

  const rejectedModel = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts", "run-goal-runtime.mjs"),
    "--materialize-only", "--pi-dir", path.join(temporaryRoot, "rejected-model"),
    "--", "--model", "anthropic/not-on-roster",
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8", env: { ...process.env, ...markerSecrets } });
  assert.notEqual(rejectedModel.status, 0);
  assert.match(rejectedModel.stderr, /unlisted Pi model selection/);

  for (const disabledPolicyFlag of ["--no-extensions", "-ne", "--no-prompt-templates", "-np"]) {
    const rejectedPolicy = spawnSync(process.execPath, [
      path.join(REPOSITORY_ROOT, "scripts", "run-goal-runtime.mjs"),
      "--materialize-only", "--pi-dir", path.join(temporaryRoot, `rejected-${disabledPolicyFlag.replace(/^-+/, "")}`),
      "--", disabledPolicyFlag,
    ], { cwd: REPOSITORY_ROOT, encoding: "utf8", env: { ...process.env, ...markerSecrets } });
    assert.notEqual(rejectedPolicy.status, 0, `${disabledPolicyFlag} cannot disable the strict runtime policy`);
    assert.match(rejectedPolicy.stderr, /prompt-policy overrides are disabled/);
  }

  const literalSecret = "literal-cli-secret-must-not-print";
  const rejectedApiKey = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts", "run-goal-runtime.mjs"),
    "--materialize-only", "--pi-dir", path.join(temporaryRoot, "rejected-key"),
    "--", "--api-key", literalSecret,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8", env: { ...process.env, ...markerSecrets } });
  assert.notEqual(rejectedApiKey.status, 0);
  assert.equal(`${rejectedApiKey.stdout}\n${rejectedApiKey.stderr}`.includes(literalSecret), false);

  const tmuxPreview = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts", "run-goal-tmux.mjs"),
    "--run-id", "ci-proof", "--", "--model", "zai/glm-5.2",
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(tmuxPreview.status, 0, tmuxPreview.stderr || tmuxPreview.stdout);
  assert.match(tmuxPreview.stdout, /socket: pi-goal-ci-proof/);
  assert.match(tmuxPreview.stdout, /default_tmux_server_touched: false/);
  assert.match(tmuxPreview.stdout, /launch: SKIPPED \(--start is required\)/);

  console.log("model_runtime_test: PASS");
  console.log(`profiles: ${roster.profiles.length}`);
  console.log(`catalog_hash: ${roster.catalogHash}`);
  console.log("credential_values_persisted: false");
  console.log("offline_network_calls_permitted: false");
  console.log("private_tmux_preview: PASS");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
