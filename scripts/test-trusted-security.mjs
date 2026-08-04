#!/usr/bin/env node

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createSigningState } from "../dist/cyber-runtime.js";
import { validateApprovalForCommand } from "../dist/domain/approval.js";
import { createStateManager } from "../dist/state.js";
import { runLocalReleaseGate } from "../dist/review/gates/release-gate.js";
import { registerGoalShellTool } from "../dist/shell.js";
import { isSafeReadOnly, requiresOperatorApproval } from "../dist/safety.js";
import {
  assertTrustedProcessSupervisorBytes,
  detectTrustedVerificationSandboxBackend,
  diagnoseTrustedVerificationSandboxBackend,
  loadTrustedVerificationConfig,
  readTrustedVerificationReceipt,
  runTrustedVerification,
} from "../dist/trusted-verification.js";

const cliArgs = process.argv.slice(2);
if (cliArgs.some((arg) => arg !== "--require-backend")) {
  throw new Error("usage: test-trusted-security.mjs [--require-backend]");
}
const requireBackend = cliArgs.includes("--require-backend");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
}

function writeSettings(root, config) {
  const settingsDir = path.join(root, ".pi");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
    iterativeGoal: { trustedVerification: config },
  }, null, 2));
}

function commitTrustedPolicy(root, config, message) {
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "trusted-verification.json"), JSON.stringify({
    schema: "pi-iterative-goal.trusted-verification-config.v1",
    ...config,
  }, null, 2));
  git(root, "add", "config/trusted-verification.json");
  git(root, "commit", "-qm", message);
}

function expectThrow(fn, pattern) {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, "expected function to throw");
  assert.match(String(thrown), pattern);
}

const trustedSupervisorBytes = fs.readFileSync(new URL("./trusted-process-supervisor.mjs", import.meta.url));
assert.doesNotThrow(() => assertTrustedProcessSupervisorBytes(trustedSupervisorBytes));
assert.doesNotMatch(
  trustedSupervisorBytes.toString("utf8"),
  /(?:child\.kill\(|process\.kill\(activeChildPid)/,
  "trusted supervisor must delegate cleanup to the parent-owned process group, never a raw child PID",
);
const tamperedSupervisorBytes = Buffer.from(trustedSupervisorBytes);
tamperedSupervisorBytes[Math.floor(tamperedSupervisorBytes.length / 2)] ^= 1;
expectThrow(
  () => assertTrustedProcessSupervisorBytes(tamperedSupervisorBytes),
  /trusted process supervisor digest mismatch/,
);

for (const command of [
  "find src -maxdepth 2 -type f -print",
  "sed -n '1,5p' src/safety.ts",
  "npm audit --json",
  "rg -n safety src",
]) {
  assert.equal(isSafeReadOnly(command), true, `${command} remains an allowlisted read`);
  assert.equal(requiresOperatorApproval(command), false, `${command} does not need operator approval`);
}
for (const command of [
  "find . -delete",
  "find . -exec touch victim ;",
  "find . -execdir touch victim ;",
  "find . -fprint victim",
  "sed -n -i.bak '1p' victim",
  "sed -ni '1p' victim",
  "sed -n --in-place=.bak '1p' victim",
  "npm audit fix",
  "npm audit --fix",
  "rg --pre 'touch victim' needle .",
  "rg --pre=touch needle .",
]) {
  assert.equal(isSafeReadOnly(command), false, `${command} must not inherit safety from its executable prefix`);
  assert.equal(requiresOperatorApproval(command), true, `${command} requires operator approval`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function runSupervisorGroupAuthorityProbe() {
  const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  unrelated.unref();
  let helperGroup;
  let helperGroupNeedsCleanup = false;
  try {
    const nonce = "b".repeat(64);
    const payload = [
      "const{spawn}=require('node:child_process');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "child.unref();console.log(child.pid);",
    ].join("");
    const request = {
      executable: process.execPath,
      argv: ["-e", payload],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      maxBufferBytes: 4_096,
      requestNonce: nonce,
    };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./trusted-process-supervisor.mjs", import.meta.url))], {
      input: JSON.stringify(request),
      encoding: "utf8",
      detached: true,
      timeout: 4_000,
    });
    helperGroup = result.pid;
    helperGroupNeedsCleanup = Number.isSafeInteger(helperGroup) && helperGroup > 1;
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    const groupedChild = Number.parseInt(response.stdout.trim(), 10);
    assert.equal(response.supervisorPid, helperGroup, "parent-observed helper PID must be the only group authority");
    assert.equal(response.requestNonce, nonce, "supervisor response must bind the one-use request nonce");
    assert.equal(processAlive(groupedChild), true);
    assert.equal(processAlive(unrelated.pid), true);
    try { process.kill(-helperGroup, "SIGTERM"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    for (let attempt = 0; attempt < 20 && processAlive(groupedChild); attempt += 1) wait(25);
    if (processAlive(groupedChild)) {
      try { process.kill(-helperGroup, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    for (let attempt = 0; attempt < 80 && processAlive(groupedChild); attempt += 1) wait(25);
    assert.equal(processAlive(groupedChild), false, "the parent-owned helper group must contain its descendants");
    helperGroupNeedsCleanup = false;
    assert.equal(processAlive(unrelated.pid), true, "group cleanup must not signal an unrelated sibling");
  } finally {
    if (helperGroupNeedsCleanup && Number.isSafeInteger(helperGroup) && helperGroup > 1) {
      try { process.kill(-helperGroup, "SIGKILL"); } catch { /* group already extinct */ }
    }
    if (unrelated.exitCode === null && unrelated.signalCode === null
      && Number.isSafeInteger(unrelated.pid) && unrelated.pid > 1) {
      try { unrelated.kill("SIGKILL"); } catch { /* direct test child already exited */ }
    }
  }
}

runSupervisorGroupAuthorityProbe();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-trusted-security-"));
try {
  const repo = path.join(scratch, "repo");
  const external = path.join(scratch, "external");
  const cacheTrap = path.join(external, "cache-trap");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  fs.mkdirSync(cacheTrap, { recursive: true });
  fs.writeFileSync(path.join(cacheTrap, "sentinel.txt"), "cache-trap-unchanged\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  fs.writeFileSync(path.join(repo, "sub", "sentinel.txt"), "sentinel\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "trusted-fixture", version: "1.0.0" }, null, 2));
  fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({
    name: "trusted-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "trusted-fixture", version: "1.0.0" } },
  }, null, 2));
  fs.symlinkSync(external, path.join(repo, "escape"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "trusted-security@example.invalid");
  git(repo, "config", "user.name", "Trusted Security Test");
  git(repo, "add", "tracked.txt", "sub/sentinel.txt", "package.json", "package-lock.json", "escape");
  git(repo, "commit", "-qm", "fixture");

  const config = {
    enabled: true,
    checks: [
      {
        id: "cwd-check",
        name: "check detached subdirectory cwd",
        required: true,
        command: {
          executable: process.execPath,
          argv: ["-e", "const fs=require('fs'); if(!fs.existsSync('sentinel.txt')) process.exit(7); console.log('cwd-ok')"],
          cwd: "sub",
          timeoutMs: 10_000,
        },
      },
      {
        id: "nested-git-init",
        name: "resolve nested git without an ambient developer-tool shim",
        required: true,
        command: {
          executable: process.execPath,
          argv: ["-e", [
            "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');",
            "const repo=fs.mkdtempSync(path.join(os.tmpdir(),'nested-git-'));",
            "const result=spawnSync('git',['init','-q'],{cwd:repo,encoding:'utf8'});",
            "if(result.status!==0){console.error(result.stderr||result.error?.message||'git init failed');process.exit(result.status??1)}",
            "console.log('nested-git-ok');",
          ].join("")],
          timeoutMs: 10_000,
        },
      },
    ],
  };
  writeSettings(repo, config);

  const state = {
    runId: "ig-trusted-security",
    cycle: 1,
    signing: createSigningState("ig-trusted-security"),
    sandbox: { profile: "local_build" },
    attestations: [],
  };
  const runDir = path.join(fs.realpathSync(repo), ".pi", "iterative-goal", "runs", state.runId);
  const cycleDir = path.join(runDir, "cycles", "1");
  const phaseDir = path.join(cycleDir, "validate");
  const manager = {
    getRunDir() { return runDir; },
    getPhaseDir(_cycle, phase) {
      const directory = path.join(cycleDir, phase);
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },
    getArtifactPath(_cycle, phase, filename) {
      const directory = path.join(cycleDir, phase);
      fs.mkdirSync(directory, { recursive: true });
      return path.join(directory, filename);
    },
    recordAttestation(attestation) { state.attestations.push(attestation); },
  };

  // These predictable legacy paths are intentionally hostile. The verifier
  // must neither reuse the source cache nor follow fixed artifact symlinks.
  const legacyManagedDir = path.join(repo, ".pi", "iterative-goal", "managed");
  fs.mkdirSync(legacyManagedDir, { recursive: true });
  const legacyCachePath = path.join(legacyManagedDir, "verification-npm-cache");
  fs.symlinkSync(cacheTrap, legacyCachePath);
  fs.mkdirSync(phaseDir, { recursive: true });
  const receiptTrap = path.join(external, "receipt-trap.json");
  const resultTrap = path.join(external, "result-trap.txt");
  const resultsListTrap = path.join(external, "results-list-trap.jsonl");
  fs.writeFileSync(receiptTrap, "receipt-trap-unchanged\n");
  fs.writeFileSync(resultTrap, "result-trap-unchanged\n");
  fs.writeFileSync(resultsListTrap, "results-list-trap-unchanged\n");
  fs.symlinkSync(receiptTrap, path.join(phaseDir, "trusted-verification-receipt.json"));
  fs.symlinkSync(resultTrap, path.join(phaseDir, "trusted-cwd-check.txt"));
  fs.symlinkSync(resultsListTrap, path.join(phaseDir, "trusted-verification-results.jsonl"));

  const sandboxBackend = detectTrustedVerificationSandboxBackend();
  if (!sandboxBackend && requireBackend) {
    const diagnostic = diagnoseTrustedVerificationSandboxBackend();
    throw new Error(`required trusted verification sandbox backend is unavailable: ${diagnostic.backend ?? "none"}: ${diagnostic.reason}`);
  }
  if (sandboxBackend && requireBackend) {
    assert.equal(
      sandboxBackend.backend,
      process.platform === "darwin" ? "macos-sandbox-exec" : "linux-bwrap",
      "CI must exercise the platform's exact trusted sandbox backend",
    );
  }
  if (!sandboxBackend) {
    expectThrow(
      () => runTrustedVerification({ cwd: path.join(repo, "sub"), state, stateManager: manager, config }),
      /requires an enforceable OS sandbox/,
    );
    assert.equal(
      fs.existsSync(path.join(phaseDir, "trusted-verification-receipt.json")),
      false,
      "an unavailable/nested OS sandbox must never degrade to a host-trusted receipt",
    );
  } else {
  const sandboxServer = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    sandboxServer.once("error", reject);
    sandboxServer.listen(0, "127.0.0.1", resolve);
  });
  const sandboxPort = sandboxServer.address().port;
  config.checks.push({
    id: "sandbox-escape",
    name: "deny source read, outside write, and loopback network",
    required: true,
    command: {
      executable: process.execPath,
      argv: ["-e", [
        "const fs=require('node:fs'),net=require('node:net');",
        "let denied=0;",
        "try{fs.readFileSync(process.argv[1]);}catch{denied++;}",
        "try{fs.writeFileSync(process.argv[2],'escape');}catch{denied++;}",
        "const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[3])});",
        "socket.once('connect',()=>process.exit(91));",
        "socket.once('error',()=>process.exit(denied===2?0:92));",
        "setTimeout(()=>process.exit(93),3000);",
      ].join(""), path.join(repo, "tracked.txt"), path.join(external, "sandbox-escape.txt"), String(sandboxPort)],
      timeoutMs: 10_000,
    },
  });
  config.checks.push({
    id: "descendant-cleanup",
    name: "terminate grouped daemons and deny detached escapes",
    required: true,
    command: {
      executable: process.execPath,
      argv: ["-e", [
        "const{spawn}=require('node:child_process');",
        "const grouped=spawn('/bin/sh',['-c',\"trap '' TERM; while :; do sleep 1; done\"],{stdio:'ignore'});grouped.unref();",
        "console.log('DESCENDANT_GROUP_PID='+grouped.pid);",
        "const finish=(pid)=>{if(pid)console.log('DESCENDANT_DETACHED_PID='+pid);setTimeout(()=>process.exit(0),250)};",
        "const detached=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
        "detached.once('spawn',()=>{detached.unref();finish(detached.pid)});",
        "detached.once('error',()=>finish(null));",
      ].join("")],
      timeoutMs: 10_000,
    },
  });
  config.checks.push({
    id: "descendant-lifetime",
    name: "terminate a same-group descendant after its direct parent exits",
    required: true,
    command: {
      executable: process.execPath,
      argv: ["-e", [
        "const {spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
        "child.unref();",
        "console.log(child.pid);",
      ].join("")],
      timeoutMs: 10_000,
    },
  });
  config.checks.push({
    id: "fast-exit",
    name: "capture an immediate child exit without an event-listener race",
    required: true,
    command: {
      executable: process.execPath,
      argv: ["-e", "process.exit(0)"],
      timeoutMs: 1_000,
    },
  });
  commitTrustedPolicy(repo, config, "add committed trusted verification policy");
  writeSettings(repo, config);
  const receipt = runTrustedVerification({ cwd: path.join(repo, "sub"), state, stateManager: manager, config });
  assert.equal(receipt.ok, true);
  assert.equal(fs.lstatSync(path.join(phaseDir, "trusted-verification-receipt.json")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(receiptTrap, "utf8"), "receipt-trap-unchanged\n");
  assert.equal(fs.readFileSync(resultTrap, "utf8"), "result-trap-unchanged\n");
  assert.equal(fs.readFileSync(resultsListTrap, "utf8"), "results-list-trap-unchanged\n");
  assert.equal(fs.lstatSync(legacyCachePath).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(cacheTrap), ["sentinel.txt"], "source-tree cache symlink must never be used");
  assert.match(receipt.dependencyBootstrap?.name ?? "", /integrity-verified private cache/);
  assert.equal(receipt.dependencyMaterialization?.status, "PASS");
  assert.equal(receipt.dependencyMaterialization?.uniqueTarballs, 0);
  assert.equal(receipt.dependencyMaterialization?.verifiedCacheHits, 0);
  assert.equal(receipt.dependencyMaterialization?.verifiedRegistryFetches, 0);
  assert.equal(receipt.dependencyMaterialization?.networkUsed, false);
  assert.equal(JSON.stringify(receipt.dependencyMaterialization).includes("https://"), false);
  assert.match(receipt.results[0].artifact, /trusted-attempt-/);
  assert.equal(fs.statSync(path.dirname(receipt.results[0].artifact)).mode & 0o077, 0, "artifact attempt directory is private");
  assert.deepEqual(receipt.sandbox, sandboxBackend);
  assert.equal(receipt.results.find((result) => result.id === "sandbox-escape")?.status, "PASS");
  const descendantResult = receipt.results.find((result) => result.id === "descendant-cleanup");
  assert.equal(descendantResult?.status, "PASS");
  assert.equal(descendantResult?.processContainment?.isolatedProcessGroup, true);
  assert.equal(descendantResult?.processContainment?.descendantsTerminated, true);
  assert.equal(
    descendantResult?.processContainment?.identityCensus,
    sandboxBackend.backend === "macos-sandbox-exec" ? "macos-sandbox-check-v1" : "linux-pid-namespace-v1",
  );
  if (sandboxBackend.backend === "macos-sandbox-exec") {
    assert.ok(descendantResult.processContainment.identityMatchesObserved >= 1, "detached Seatbelt child must be observed by the identity census");
  }
  const descendantArtifact = fs.readFileSync(descendantResult.artifact, "utf8");
  assert.match(descendantArtifact, /Identity census: (?:macos-sandbox-check-v1|linux-pid-namespace-v1)/);
  assert.match(descendantArtifact, /Identity matches observed: \d+/);
  let observedDescendantPids = 0;
  for (const match of descendantArtifact.matchAll(/DESCENDANT_(?:GROUP|DETACHED)_PID=(\d+)/g)) {
    const pid = Number.parseInt(match[1], 10);
    observedDescendantPids += 1;
    // linux-bwrap reports namespace-INNER pids; host-side liveness is
    // meaningless for them (collides with real host processes). The
    // descendantsTerminated + pid-namespace census assertions above are the
    // authoritative bound there.
    if (sandboxBackend.backend === "macos-sandbox-exec") {
      assert.equal(processAlive(pid), false, `sandbox descendant ${pid} must not outlive its check`);
    }
  }
  assert.ok(observedDescendantPids >= 1, "daemon containment test must observe at least one spawned descendant");
  const lifetimeResult = receipt.results.find((result) => result.id === "descendant-lifetime");
  assert.equal(lifetimeResult?.status, "PASS");
  assert.equal(lifetimeResult?.processContainment.isolatedProcessGroup, true);
  assert.equal(lifetimeResult?.processContainment.descendantsTerminated, true);
  if (sandboxBackend.backend === "macos-sandbox-exec") {
    assert.match(lifetimeResult?.processContainment.cleanupSignal ?? "", /^SIG(?:TERM|KILL)$/);
  }
  const lifetimeArtifact = fs.readFileSync(lifetimeResult.artifact, "utf8");
  const lifetimePidMatch = lifetimeArtifact.match(/STDOUT:\n(\d+)\n/);
  assert.ok(lifetimePidMatch, "same-group daemon test must record its descendant PID");
  const lifetimePid = Number.parseInt(lifetimePidMatch[1], 10);
  if (sandboxBackend.backend === "macos-sandbox-exec") {
    assert.equal(processAlive(lifetimePid), false, `same-group descendant ${lifetimePid} must not outlive its check`);
  }
  const fastExitResult = receipt.results.find((result) => result.id === "fast-exit");
  assert.equal(fastExitResult?.status, "PASS");
  assert.equal(fastExitResult?.timedOut, false);
  assert.equal(fastExitResult?.processContainment.descendantsTerminated, true);
  assert.equal(fs.existsSync(path.join(external, "sandbox-escape.txt")), false);
  assert.equal(receipt.sourceSha, git(repo, "rev-parse", "HEAD"));
  assert.equal(receipt.dependencyBootstrap?.status, "PASS");
  assert.equal(receipt.results[0].status, "PASS");
  assert.match(fs.readFileSync(receipt.results[0].artifact, "utf8"), /cwd-ok/);
  assert.ok(readTrustedVerificationReceipt(path.join(repo, "sub"), state, manager));

  const receiptPath = path.join(phaseDir, "trusted-verification-receipt.json");
  const receiptBytes = fs.readFileSync(receiptPath, "utf8");
  const artifactPath = receipt.results[0].artifact;
  const artifactBytes = fs.readFileSync(artifactPath);
  const signature = state.attestations.at(-1).cryptographicSignature;

  fs.appendFileSync(artifactPath, "tamper\n");
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "artifact tamper must invalidate receipt");
  fs.writeFileSync(artifactPath, artifactBytes);
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  const artifactBackup = `${artifactPath}.backup`;
  fs.renameSync(artifactPath, artifactBackup);
  fs.symlinkSync(resultTrap, artifactPath);
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "artifact symlink substitution must invalidate receipt");
  fs.unlinkSync(artifactPath);
  fs.renameSync(artifactBackup, artifactPath);
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  fs.writeFileSync(receiptPath, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20));
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "oversized receipt input fails closed before JSON allocation");
  fs.writeFileSync(receiptPath, receiptBytes);
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  const modifiedReceipt = JSON.parse(receiptBytes);
  modifiedReceipt.ok = false;
  fs.writeFileSync(receiptPath, JSON.stringify(modifiedReceipt, null, 2));
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "receipt tamper must invalidate signature");
  fs.writeFileSync(receiptPath, receiptBytes);

  const containmentTamper = JSON.parse(receiptBytes);
  containmentTamper.results[0].processContainment.descendantsTerminated = false;
  fs.writeFileSync(receiptPath, JSON.stringify(containmentTamper, null, 2));
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "descendant containment tamper must invalidate receipt");
  fs.writeFileSync(receiptPath, receiptBytes);

  state.attestations.at(-1).cryptographicSignature = Buffer.from("invalid").toString("base64");
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "signature tamper must invalidate receipt");
  state.attestations.at(-1).cryptographicSignature = signature;
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "tracked dirt must invalidate receipt");
  expectThrow(
    () => runTrustedVerification({ cwd: repo, state, stateManager: manager, config }),
    /clean tracked source tree/,
  );
  assert.equal(fs.existsSync(receiptPath), false, "failed rerun must invalidate an older PASS receipt");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");

  let fresh = runTrustedVerification({ cwd: repo, state, stateManager: manager, config });
  assert.equal(fresh.ok, true);
  git(repo, "update-index", "--assume-unchanged", "tracked.txt");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "assume-unchanged-dirt\n");
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "fresh-index comparison defeats assume-unchanged hiding");
  expectThrow(
    () => runTrustedVerification({ cwd: repo, state, stateManager: manager, config }),
    /clean tracked source tree/,
  );
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, "update-index", "--no-assume-unchanged", "tracked.txt");
  fresh = runTrustedVerification({ cwd: repo, state, stateManager: manager, config });
  assert.equal(fresh.ok, true);
  const oldHead = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "head-change.txt"), "new head\n");
  git(repo, "add", "head-change.txt");
  git(repo, "commit", "-qm", "head change");
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null, "receipt must bind current HEAD");
  git(repo, "checkout", "-q", "--detach", oldHead);
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  const changedConfig = structuredClone(config);
  changedConfig.checks[0] = {
    id: "forged-pass",
    name: "ignored local settings must not replace committed checks",
    required: true,
    command: { executable: process.execPath, argv: ["-e", "process.exit(0)"], timeoutMs: 10_000 },
  };
  writeSettings(repo, changedConfig);
  assert.deepEqual(loadTrustedVerificationConfig(repo), config, "ignored local settings never become a trusted verification authority");
  assert.ok(readTrustedVerificationReceipt(repo, state, manager), "ignored local settings cannot invalidate or replace a HEAD-bound receipt");
  writeSettings(repo, config);
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  const escapedCwdConfig = structuredClone(config);
  escapedCwdConfig.checks[0].command.cwd = "../";
  expectThrow(
    () => runTrustedVerification({ cwd: repo, state, stateManager: manager, config: escapedCwdConfig }),
    /cwd escapes validation worktree/,
  );
  assert.equal(fs.existsSync(receiptPath), false, "throwing rerun must leave no stale receipt");

  const symlinkCwdConfig = structuredClone(config);
  symlinkCwdConfig.checks[0].command.cwd = "escape";
  expectThrow(
    () => runTrustedVerification({ cwd: repo, state, stateManager: manager, config: symlinkCwdConfig }),
    /cwd resolves outside validation worktree/,
  );

  const externalExecutable = path.join(external, "mutable-pass");
  fs.writeFileSync(externalExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const mutableExecutableConfig = structuredClone(config);
  mutableExecutableConfig.checks[0].command.executable = externalExecutable;
  expectThrow(
    () => runTrustedVerification({ cwd: repo, state, stateManager: manager, config: mutableExecutableConfig }),
    /trusted verification check is invalid/,
  );

  const detachedHeadDriftConfig = structuredClone(config);
  detachedHeadDriftConfig.checks[0] = {
    id: "head-drift",
    name: "mutate detached validation HEAD",
    required: true,
    command: {
      executable: "git",
      argv: ["-c", "user.name=Trusted Security Test", "-c", "user.email=trusted-security@example.invalid", "commit", "--allow-empty", "-m", "validation head drift"],
      timeoutMs: 10_000,
    },
  };
  writeSettings(repo, detachedHeadDriftConfig);
  const headDriftReceipt = runTrustedVerification({ cwd: repo, state, stateManager: manager, config: detachedHeadDriftConfig });
  assert.equal(
    headDriftReceipt.results[0].status,
    "PASS",
    fs.readFileSync(headDriftReceipt.results[0].artifact, "utf8"),
  );
  assert.notEqual(headDriftReceipt.validationSha, headDriftReceipt.validationShaAfter);
  assert.equal(headDriftReceipt.ok, false, "a check that changes detached validation HEAD cannot certify source HEAD");
  assert.equal(readTrustedVerificationReceipt(repo, state, manager), null);

  const failedOptionalConfig = structuredClone(config);
  failedOptionalConfig.checks[0] = {
    id: "optional-failure",
    name: "optional failure remains accurately labeled",
    required: false,
    command: { executable: process.execPath, argv: ["-e", "process.exit(9)"], timeoutMs: 10_000 },
  };
  commitTrustedPolicy(repo, failedOptionalConfig, "change committed trusted verification policy");
  writeSettings(repo, failedOptionalConfig);
  const optionalReceipt = runTrustedVerification({ cwd: repo, state, stateManager: manager, config: failedOptionalConfig });
  assert.equal(optionalReceipt.results[0].status, "FAIL");
  assert.equal(optionalReceipt.ok, true, "an explicitly optional failure does not fail required gates");
  assert.ok(readTrustedVerificationReceipt(repo, state, manager));

  fs.writeFileSync(manager.getArtifactPath(1, "implement", "implementation-verification.json"), JSON.stringify({
    allowlistViolation: false,
    extraFiles: [],
  }));
  fs.writeFileSync(manager.getArtifactPath(1, "validate", "verification-results.jsonl"), `${JSON.stringify({ id: "release", status: "PASS" })}\n`);
  state.artifacts = { validations: [{ cycle: 1, status: "completed" }] };
  state.trustedVerification = {
    required: true,
    checksHash: optionalReceipt.checksHash,
    pinnedAt: new Date().toISOString(),
  };
  const releaseGate = await runLocalReleaseGate(state, manager, repo);
  assert.deepEqual(releaseGate, { ok: true, reasons: [] }, "release gate must use its explicit repository cwd");
  commitTrustedPolicy(repo, { enabled: false, checks: [] }, "disable committed trusted verification policy");
  writeSettings(repo, { enabled: false, checks: [] });
  const downgradedRelease = await runLocalReleaseGate(state, manager, repo);
  assert.ok(downgradedRelease.reasons.some((reason) => /pinned trusted-verification policy/.test(reason)));
  writeSettings(repo, failedOptionalConfig);

  // A lockfile that needs a remote tarball cannot use ambient/global npm
  // caches or the network. The fresh per-attempt offline cache must make the
  // dependency bootstrap fail, and that failure must prevent certification.
  const offlineRepo = path.join(scratch, "offline-bootstrap-repo");
  fs.mkdirSync(offlineRepo);
  fs.writeFileSync(path.join(offlineRepo, "package.json"), JSON.stringify({
    name: "offline-bootstrap-fixture",
    version: "1.0.0",
    dependencies: { "pi-ig-intentionally-uncached": "1.0.0" },
  }, null, 2));
  fs.writeFileSync(path.join(offlineRepo, "package-lock.json"), JSON.stringify({
    name: "offline-bootstrap-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "offline-bootstrap-fixture",
        version: "1.0.0",
        dependencies: { "pi-ig-intentionally-uncached": "1.0.0" },
      },
      "node_modules/pi-ig-intentionally-uncached": {
        version: "1.0.0",
        resolved: "https://example.invalid/pi-ig-intentionally-uncached-1.0.0.tgz",
      },
    },
  }, null, 2));
  git(offlineRepo, "init", "-q");
  git(offlineRepo, "config", "user.email", "trusted-security@example.invalid");
  git(offlineRepo, "config", "user.name", "Trusted Security Test");
  git(offlineRepo, "add", "package.json", "package-lock.json");
  git(offlineRepo, "commit", "-qm", "offline bootstrap fixture");
  const offlineState = {
    runId: "ig-offline-bootstrap",
    cycle: 1,
    signing: createSigningState("ig-offline-bootstrap"),
    sandbox: { profile: "local_build" },
    attestations: [],
  };
  const offlineRunDir = path.join(fs.realpathSync(offlineRepo), ".pi", "iterative-goal", "runs", offlineState.runId);
  const offlineManager = {
    getRunDir() { return offlineRunDir; },
    getPhaseDir(_cycle, phase) {
      const directory = path.join(offlineRunDir, "cycles", "1", phase);
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },
    getArtifactPath(_cycle, phase, filename) {
      return path.join(this.getPhaseDir(1, phase), filename);
    },
    recordAttestation(attestation) { offlineState.attestations.push(attestation); },
  };
  const offlineConfig = {
    enabled: true,
    checks: [{
      id: "local-check",
      name: "local check must not run",
      required: true,
      command: {
        executable: process.execPath,
        argv: ["-e", "process.exit(73)"],
        timeoutMs: 10_000,
      },
    }],
  };
  writeSettings(offlineRepo, offlineConfig);
  const offlineReceipt = runTrustedVerification({
    cwd: offlineRepo,
    state: offlineState,
    stateManager: offlineManager,
    config: offlineConfig,
  });
  assert.equal(offlineReceipt.dependencyMaterialization?.status, "FAIL");
  assert.equal(offlineReceipt.dependencyMaterialization?.networkUsed, false, "a disallowed lock origin fails before network");
  assert.equal(JSON.stringify(offlineReceipt.dependencyMaterialization).includes("https://"), false);
  assert.equal(offlineReceipt.dependencyBootstrap?.status, "NOT_RUN");
  assert.equal(offlineReceipt.dependencyBootstrap?.exitCode, null);
  assert.equal(offlineReceipt.dependencyBootstrap?.processContainment.isolatedProcessGroup, false);
  assert.match(fs.readFileSync(offlineReceipt.dependencyBootstrap.artifact, "utf8"), /dependency materialization failed/);
  assert.equal(offlineReceipt.results[0]?.status, "NOT_RUN");
  assert.equal(offlineReceipt.results[0]?.exitCode, null);
  assert.equal(offlineReceipt.results[0]?.processContainment.isolatedProcessGroup, false);
  assert.match(fs.readFileSync(offlineReceipt.results[0].artifact, "utf8"), /dependency materialization failed/);
  assert.equal(offlineReceipt.ok, false, "an empty offline cache miss must fail closed");
  const offlineReceiptPath = path.join(offlineRunDir, "cycles", "1", "validate", "trusted-verification-receipt.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(offlineReceiptPath, "utf8")), offlineReceipt, "failed materialization leaves a durable receipt");
  assert.equal(offlineState.attestations.length, 1, "failed materialization receipt is signed for auditability");
  assert.equal(readTrustedVerificationReceipt(offlineRepo, offlineState, offlineManager), null);

  const phaseBackup = `${phaseDir}.real`;
  const phaseSymlinkTrap = path.join(external, "phase-symlink-trap");
  fs.mkdirSync(phaseSymlinkTrap);
  fs.renameSync(phaseDir, phaseBackup);
  fs.symlinkSync(phaseSymlinkTrap, phaseDir);
  expectThrow(
    () => runTrustedVerification({ cwd: repo, state, stateManager: manager, config: failedOptionalConfig }),
    /artifact path contains a symbolic link/,
  );
  assert.deepEqual(fs.readdirSync(phaseSymlinkTrap), [], "a symlinked artifact directory must receive no writes");
  fs.unlinkSync(phaseDir);
  fs.renameSync(phaseBackup, phaseDir);
  sandboxServer.close();
  }

  const now = Date.now();
  const approval = {
    token: "APPROVAL_test",
    runId: "run-1",
    cycle: 3,
    phaseAttemptId: "run-1/c3/implement/a2",
    cwd: "/repo",
    requestedAction: "remove fixture",
    blastRadiusAssessment: "one file",
    justification: "test",
    rollbackPlan: "restore fixture",
    affectedResources: ["fixture"],
    exactCommands: ["rm fixture"],
    exactAwsActions: [],
    dataAccessScope: null,
    requestedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    status: "approved",
    resolvedAt: new Date(now - 500).toISOString(),
    usedAt: null,
    usedForCommand: null,
  };
  const approvalContext = {
    runId: "run-1",
    cycle: 3,
    phaseAttemptId: "run-1/c3/implement/a2",
    cwd: "/repo",
    command: "rm fixture",
    nowMs: now,
  };
  assert.equal(validateApprovalForCommand(approval, approvalContext).ok, true);
  for (const [label, changedRequest, changedContext] of [
    ["missing scope", { ...approval, runId: undefined }, approvalContext],
    ["wrong run", approval, { ...approvalContext, runId: "run-2" }],
    ["wrong cycle", approval, { ...approvalContext, cycle: 4 }],
    ["wrong phase attempt", approval, { ...approvalContext, phaseAttemptId: "run-1/c3/implement/a3" }],
    ["wrong cwd", approval, { ...approvalContext, cwd: "/elsewhere" }],
    ["wrong command", approval, { ...approvalContext, command: "rm other" }],
    ["expired", { ...approval, expiresAt: new Date(now - 1).toISOString() }, approvalContext],
    ["unresolved", { ...approval, resolvedAt: null }, approvalContext],
    ["used", { ...approval, usedAt: new Date(now - 100).toISOString(), usedForCommand: "rm fixture" }, approvalContext],
  ]) {
    assert.equal(validateApprovalForCommand(changedRequest, changedContext).ok, false, `${label} approval must fail`);
  }

  const approvalStateRoot = path.join(scratch, "approval-state");
  fs.mkdirSync(approvalStateRoot);
  const stateManager = createStateManager({ appendEntry() {} });
  stateManager.restore({ cwd: approvalStateRoot, sessionManager: { getEntries: () => [] } });
  const active = stateManager.createRun("approval test", "one use");
  const activePhaseAttemptId = `${active.runId}/c${active.cycle}/implement/a1`;
  stateManager.acquireLock(active.runId, activePhaseAttemptId);
  const stateApproval = {
    ...approval,
    token: "APPROVAL_state",
    runId: active.runId,
    cycle: active.cycle,
    phaseAttemptId: activePhaseAttemptId,
    cwd: approvalStateRoot,
    status: "pending",
    resolvedAt: null,
  };
  stateManager.requestApproval(stateApproval);
  const resolved = stateManager.resolveApproval(stateApproval.token, "approved");
  assert.equal(resolved.status, "approved");
  assert.equal(stateManager.consumeApproval(stateApproval.token, "rm fixture", approvalStateRoot).ok, true);
  assert.equal(stateManager.consumeApproval(stateApproval.token, "rm fixture", approvalStateRoot).ok, false, "approval is single use");

  let shellTool = null;
  let executions = 0;
  const fakePi = {
    registerTool(tool) { shellTool = tool; },
    async exec() {
      executions += 1;
      return { code: 0, stdout: "simulated\n", stderr: "", killed: false };
    },
  };
  registerGoalShellTool(fakePi, undefined, undefined, stateManager);
  assert.ok(shellTool, "goal_shell tool registered");
  const shellApproval = {
    ...stateApproval,
    token: "APPROVAL_shell",
    status: "pending",
    resolvedAt: null,
    usedAt: null,
    usedForCommand: null,
  };
  stateManager.requestApproval(shellApproval);
  stateManager.resolveApproval(shellApproval.token, "approved");
  const shellResult = await shellTool.execute(
    "call-1",
    { command: "rm fixture", cwd: ".", approvalToken: shellApproval.token },
    undefined,
    undefined,
    { cwd: approvalStateRoot },
  );
  assert.equal(shellResult.details.allowed, true);
  assert.equal(shellResult.details.cwd, approvalStateRoot, "relative shell cwd is canonicalized before scope validation");
  assert.equal(executions, 1);
  const replayResult = await shellTool.execute(
    "call-2",
    { command: "rm fixture", cwd: ".", approvalToken: shellApproval.token },
    undefined,
    undefined,
    { cwd: approvalStateRoot },
  );
  assert.equal(replayResult.details.allowed, false, "consumed shell token cannot be replayed");
  assert.equal(executions, 1);

  for (const command of [
    "node -e \"require('node:fs').writeFileSync('bypass', 'x')\"",
    "python3 -c \"open('bypass', 'w').write('x')\"",
  ]) {
    const interpreterBypass = await shellTool.execute(
      `call-interpreter-${executions}`,
      { command },
      undefined,
      undefined,
      { cwd: approvalStateRoot },
    );
    assert.equal(interpreterBypass.details.allowed, false, `${command} must require operator approval`);
    assert.equal(interpreterBypass.details.safetyCheckResult, "operator_approval_required");
    assert.equal(executions, 1, "an interpreter bypass must not reach pi.exec");
  }

  for (const command of [
    "find . -delete",
    "find . -exec touch victim ;",
    "find . -execdir touch victim ;",
    "sed -n -i.bak '1p' victim",
    "npm audit fix",
    "rg --pre 'touch victim' needle .",
  ]) {
    const prefixedBypass = await shellTool.execute(
      `call-prefixed-bypass-${command}`,
      { command },
      undefined,
      undefined,
      { cwd: approvalStateRoot },
    );
    assert.equal(prefixedBypass.details.allowed, false, `${command} must require operator approval`);
    assert.equal(prefixedBypass.details.safetyCheckResult, "operator_approval_required");
    assert.equal(executions, 1, "a mutating/exec flag on an allowlisted prefix must not reach pi.exec");
  }

  const hardBlockedApproval = {
    ...stateApproval,
    token: "APPROVAL_hard_block",
    exactCommands: ["rm -rf fixture"],
    status: "pending",
    resolvedAt: null,
    usedAt: null,
    usedForCommand: null,
  };
  stateManager.requestApproval(hardBlockedApproval);
  stateManager.resolveApproval(hardBlockedApproval.token, "approved");
  const hardBlocked = await shellTool.execute(
    "call-3",
    { command: "rm -rf fixture", approvalToken: hardBlockedApproval.token },
    undefined,
    undefined,
    { cwd: approvalStateRoot },
  );
  assert.equal(hardBlocked.details.allowed, false);
  assert.match(hardBlocked.details.safetyCheckResult, /always-blocked/);
  assert.equal(executions, 1);
  assert.equal(
    stateManager.consumeApproval(hardBlockedApproval.token, "rm -rf fixture", approvalStateRoot).ok,
    true,
    "deterministic policy denial must not burn the approval capability",
  );

  const expiredApproval = {
    ...stateApproval,
    token: "APPROVAL_expired",
    expiresAt: new Date(Date.now() - 1).toISOString(),
  };
  stateManager.requestApproval(expiredApproval);
  assert.equal(stateManager.resolveApproval(expiredApproval.token, "approved").status, "expired");

  console.log(`trusted-security: PASS (${sandboxBackend ? `${sandboxBackend.backend} receipt signature/artifact/config/HEAD/cwd/clean-tree` : "OS sandbox unavailable -> trusted runner failed closed"} + scoped one-use approvals)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
