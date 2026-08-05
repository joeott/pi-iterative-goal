#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createStateManager } = await import("../dist/state.js");
const {
  MERGE_COMMIT_AUTHOR,
  mergeShardPlan,
  prepareIsolatedWorktree,
  recoverWorktrees,
} = await import("../dist/workspace/worktrees.js");

const tempRoots = [];

function git(repo, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  }).trim();
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "workspace-hardening@example.com"]);
  git(repo, ["config", "user.name", "Workspace Hardening"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.mjs"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "b.mjs"), "export const b = 2;\n");
  fs.writeFileSync(path.join(repo, "src", "bridge.mjs"), "export const bridge = 'base';\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "seed"]);
  return repo;
}

function makeState(repo, label) {
  const stateManager = createStateManager({ appendEntry() {} });
  assert.equal(stateManager.restore({ cwd: repo, sessionManager: { getEntries: () => [] } }), null);
  const run = stateManager.createRun(label, "workspace hardening proof");
  return { stateManager, run };
}

function planFor(runId, cycle = 1, id = `plan-${cycle}`, shards = null) {
  const entries = shards ?? [
    { id: "shard-a", index: 0, file: "src/a.mjs", rank: 500 },
    { id: "shard-b", index: 1, file: "src/b.mjs", rank: 100 },
  ];
  return {
    id,
    version: 1,
    createdAt: new Date().toISOString(),
    tasks: entries.map((entry) => ({
      id: `task-${entry.id}`,
      title: entry.id,
      dependsOn: [],
      satisfies: [],
      allowedPaths: [{ kind: "exact", path: entry.file }],
      requiredCapabilities: [],
      checks: [],
      rollback: `git checkout -- ${entry.file}`,
      risk: "low",
    })),
    runId,
    cycle,
    shards: entries.map((entry) => ({
      id: entry.id,
      index: entry.index,
      files: [entry.file],
      taskIds: [`task-${entry.id}`],
      allowedPaths: [{ kind: "exact", path: entry.file }],
      crossShardContracts: [],
    })),
    cutWeight: 0,
    totalEdgeWeight: 0,
    couplingDensity: 0,
    balanceTolerance: 0.34,
    decision: "fan_out",
    decisionReason: "workspace hardening fixture",
    algorithm: {
      prior: "spectral-fiedler",
      priorSplit: "sign",
      refinement: "kernighan-lin",
      bisections: 1,
      refinementPasses: 1,
      refinementEvaluatedSwaps: 0,
      refinementSwapsExecuted: 0,
      refinementImproved: false,
      initialCutWeight: 0,
    },
    postedAt: new Date().toISOString(),
    fixtureEntries: entries,
  };
}

function ledgerPlan(stateManager, plan) {
  stateManager.recordShardPlan(plan);
  for (const entry of plan.fixtureEntries) {
    stateManager.recordShardClaimed({
      shardId: entry.id,
      planId: plan.id,
      runId: plan.runId,
      cycle: plan.cycle,
      status: "claimed",
      workerSlot: entry.index,
      rank: entry.rank,
      taskId: `dispatch-${plan.cycle}-${entry.id}`,
      claimedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      patchArtifactPath: null,
    });
    stateManager.recordShardFinished(entry.id, {
      runId: plan.runId,
      planId: plan.id,
      cycle: plan.cycle,
      status: "completed",
      taskId: `dispatch-${plan.cycle}-${entry.id}`,
      patchArtifactPath: null,
    });
  }
}

function capturePatch(repo, taskId, file, contents) {
  const workspace = prepareIsolatedWorktree(repo, taskId);
  try {
    fs.writeFileSync(path.join(workspace.path, file), contents);
    return workspace.capturePatch();
  } finally {
    workspace.cleanup();
  }
}

function inputsFor(repo, plan, suffix) {
  return plan.fixtureEntries.map((entry) => ({
    shardId: entry.id,
    patch: capturePatch(
      repo,
      `${suffix}-${entry.id}`,
      entry.file,
      entry.id === "shard-a"
        ? `export const a = ${40 + plan.cycle};\n`
        : entry.id === "shard-b"
          ? `export const b = ${1300 + plan.cycle};\n`
          : `export const bridge = '${suffix}';\n`,
    ),
  }));
}

const mergeConfig = {
  enabled: true,
  promoteToSource: false,
  integrationBranch: null,
  testCommand: "injected",
  testTimeoutMs: 1_000,
};
const testsPass = () => ({ ok: true, output: "ok" });

try {
  // 1. The worker checkout is cut from the captured object id, then verified.
  {
    const repo = makeRepo("pi-ig-base-pin-");
    const expectedBase = git(repo, ["rev-parse", "HEAD"]);
    const workspace = prepareIsolatedWorktree(repo, "base-pin");
    try {
      assert.equal(workspace.baseSha, expectedBase);
      assert.equal(git(workspace.path, ["rev-parse", "HEAD"]), expectedBase);
      fs.writeFileSync(path.join(repo, "source-only.txt"), "source advance\n");
      git(repo, ["add", "source-only.txt"]);
      git(repo, ["commit", "-qm", "advance source after worker creation"]);
      assert.notEqual(git(repo, ["rev-parse", "HEAD"]), expectedBase);
      assert.equal(git(workspace.path, ["rev-parse", "HEAD"]), expectedBase);
    } finally {
      workspace.cleanup();
    }
    console.log("✓ workspace base SHA is immutable and verified");
  }

  // 2. Every verdict ledgers its exact commit; promotion CASes the pinned ref.
  {
    const repo = makeRepo("pi-ig-cas-promote-");
    const { stateManager, run } = makeState(repo, "exact CAS promotion");
    const plan = planFor(run.runId);
    ledgerPlan(stateManager, plan);
    const inputs = inputsFor(repo, plan, "cas");
    const sourceBefore = git(repo, ["rev-parse", "HEAD"]);
    const report = await mergeShardPlan(plan, inputs, {
      stateManager,
      cwd: repo,
      config: { ...mergeConfig, promoteToSource: true },
      runTests: testsPass,
    });
    assert.equal(report.sourceRef, "refs/heads/main");
    assert.equal(report.sourceHeadBefore, sourceBefore);
    assert.equal(report.promotionStatus, "promoted", report.promotionReason);
    assert.equal(report.deliveredSha, report.integrationHead);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), report.integrationHead);
    const merges = stateManager.getState().shards.merges;
    assert.equal(merges.length, 2);
    assert.ok(merges.every((merge) => /^[a-f0-9]{40,64}$/.test(merge.integrationCommitSha ?? "")));
    const replayed = stateManager.replayActiveState();
    assert.deepEqual(
      replayed.shards.merges.map((merge) => merge.integrationCommitSha),
      merges.map((merge) => merge.integrationCommitSha),
    );
    const reflog = git(repo, ["reflog", "show", "--format=%gs", "refs/heads/main"]);
    assert.match(reflog, /pi-iterative-goal verified shard promotion/);
    const leaseRoot = path.join(path.resolve(repo, git(repo, ["rev-parse", "--git-common-dir"])), "pi-iterative-goal", "integration-leases");
    assert.equal(fs.readdirSync(leaseRoot).length, 0, "successful merge releases lease and guard");
    console.log("✓ verified commit SHAs replay and exact attached-ref CAS promotion");
  }

  // 3. Switching to another branch at the same SHA cannot redirect delivery.
  {
    const repo = makeRepo("pi-ig-ref-pin-");
    const { stateManager, run } = makeState(repo, "attached ref pin");
    const plan = planFor(run.runId);
    ledgerPlan(stateManager, plan);
    const inputs = inputsFor(repo, plan, "ref-pin");
    const sourceBefore = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["branch", "same-sha-other", sourceBefore]);
    let switched = false;
    const report = await mergeShardPlan(plan, inputs, {
      stateManager,
      cwd: repo,
      config: { ...mergeConfig, promoteToSource: true },
      runTests: () => {
        if (!switched) {
          switched = true;
          git(repo, ["checkout", "-q", "same-sha-other"]);
        }
        return { ok: true, output: "ok" };
      },
    });
    assert.equal(report.promotionStatus, "blocked");
    assert.match(report.promotionReason, /attached source ref changed/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), sourceBefore);
    assert.equal(git(repo, ["rev-parse", "refs/heads/same-sha-other"]), sourceBefore);
    console.log("✓ same-SHA source branch switch is fail-closed");
  }

  // 4. A mutable branch reset/extra commit cannot override ledgered SHAs.
  {
    const repo = makeRepo("pi-ig-chain-proof-");
    const { stateManager, run } = makeState(repo, "commit chain proof");
    const plan = planFor(run.runId);
    ledgerPlan(stateManager, plan);
    const inputs = inputsFor(repo, plan, "chain");
    const sourceBefore = git(repo, ["rev-parse", "HEAD"]);
    const first = await mergeShardPlan(plan, inputs, {
      stateManager,
      cwd: repo,
      config: mergeConfig,
      runTests: testsPass,
    });
    const tree = git(repo, ["rev-parse", `${first.integrationHead}^{tree}`]);
    const malicious = git(repo, ["commit-tree", tree, "-p", first.integrationHead], {
      input: "unledgered integration mutation\n",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: MERGE_COMMIT_AUTHOR.name,
        GIT_AUTHOR_EMAIL: MERGE_COMMIT_AUTHOR.email,
        GIT_COMMITTER_NAME: MERGE_COMMIT_AUTHOR.name,
        GIT_COMMITTER_EMAIL: MERGE_COMMIT_AUTHOR.email,
      },
    });
    git(repo, ["update-ref", `refs/heads/${first.integrationBranch}`, malicious, first.integrationHead]);
    const resumed = await mergeShardPlan(plan, inputs, {
      stateManager,
      cwd: repo,
      config: { ...mergeConfig, promoteToSource: true },
      runTests: testsPass,
    });
    assert.equal(resumed.promotionStatus, "blocked");
    assert.match(resumed.promotionReason, /not the exact end of the verified commit chain/);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), sourceBefore);
    console.log("✓ mutable integration-branch tampering cannot bypass ledgered chain proof");
  }

  // 5. A live/ambiguous surviving worktree is never reset or reused.
  {
    const repo = makeRepo("pi-ig-live-owner-");
    const { stateManager, run } = makeState(repo, "live owner refusal");
    const firstPlan = planFor(run.runId);
    ledgerPlan(stateManager, firstPlan);
    const first = await mergeShardPlan(firstPlan, inputsFor(repo, firstPlan, "owner-1"), {
      stateManager,
      cwd: repo,
      config: mergeConfig,
      runTests: testsPass,
    });
    const survivor = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-integration-live-owner-"));
    git(repo, ["worktree", "add", "-q", survivor, first.integrationBranch]);
    fs.writeFileSync(path.join(survivor, ".pi-ig-worktree.json"), JSON.stringify({
      schema: "pi-iterative-goal.worktree-owner.v2",
      pid: process.pid,
      processStartToken: null,
      kind: "integration",
      branch: first.integrationBranch,
      leaseNonce: "ambiguous-live-owner",
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(survivor, "src", "bridge.mjs"), "operator sentinel must survive\n");
    const secondPlan = planFor(run.runId, 2, "plan-live-owner", [
      { id: "shard-bridge", index: 0, file: "src/bridge.mjs", rank: 500 },
    ]);
    ledgerPlan(stateManager, secondPlan);
    const secondInputs = inputsFor(repo, secondPlan, "owner-2");
    try {
      await assert.rejects(
        mergeShardPlan(secondPlan, secondInputs, {
          stateManager,
          cwd: repo,
          config: mergeConfig,
          runTests: testsPass,
        }),
        /ambiguous or unverifiable ownership|refusing reset\/reuse/,
      );
      assert.equal(fs.readFileSync(path.join(survivor, "src", "bridge.mjs"), "utf8"), "operator sentinel must survive\n");
    } finally {
      git(repo, ["worktree", "remove", "--force", survivor]);
    }
    console.log("✓ live/ambiguous integration worktree is preserved and refused");
  }

  // 6. The branch-scoped lease itself refuses a concurrent live owner.
  {
    const repo = makeRepo("pi-ig-live-lease-");
    const { stateManager, run } = makeState(repo, "live lease refusal");
    const firstPlan = planFor(run.runId);
    ledgerPlan(stateManager, firstPlan);
    const first = await mergeShardPlan(firstPlan, inputsFor(repo, firstPlan, "lease-1"), {
      stateManager,
      cwd: repo,
      config: mergeConfig,
      runTests: testsPass,
    });
    const secondPlan = planFor(run.runId, 2, "plan-live-lease", [
      { id: "shard-bridge", index: 0, file: "src/bridge.mjs", rank: 500 },
    ]);
    ledgerPlan(stateManager, secondPlan);
    const branch = first.integrationBranch;
    const commonDir = path.resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
    const leaseRoot = path.join(commonDir, "pi-iterative-goal", "integration-leases");
    fs.mkdirSync(leaseRoot, { recursive: true });
    const leasePath = path.join(leaseRoot, `${crypto.createHash("sha256").update(branch).digest("hex")}.json`);
    let startToken = null;
    try {
      startToken = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
    } catch {
      // Restricted CI/sandbox runners may deny process-table inspection. That
      // is an ambiguous owner, which must be preserved and refused just like
      // a positively identified live owner.
    }
    fs.writeFileSync(leasePath, JSON.stringify({
      schema: "pi-iterative-goal.integration-lease.v1",
      repoRoot: fs.realpathSync(repo),
      branch,
      pid: process.pid,
      processStartToken: startToken,
      nonce: "concurrent-live-owner",
      acquiredAt: new Date().toISOString(),
    }));
    try {
      await assert.rejects(
        mergeShardPlan(secondPlan, inputsFor(repo, secondPlan, "lease-2"), {
          stateManager,
          cwd: repo,
          config: mergeConfig,
          runTests: testsPass,
        }),
        /live lease owner|ambiguous lease owner/,
      );
      assert.equal(JSON.parse(fs.readFileSync(leasePath, "utf8")).nonce, "concurrent-live-owner");
    } finally {
      fs.unlinkSync(leasePath);
    }
    console.log("✓ atomic integration lease refuses and preserves concurrent owner");
  }

  // 7. Scoped recovery removes only a well-formed, provably dead lease.
  {
    const repo = makeRepo("pi-ig-dead-lease-");
    const branch = "pi-ig/integration/dead-owner-fixture";
    const commonDir = path.resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
    const leaseRoot = path.join(commonDir, "pi-iterative-goal", "integration-leases");
    fs.mkdirSync(leaseRoot, { recursive: true });
    const leasePath = path.join(leaseRoot, `${crypto.createHash("sha256").update(branch).digest("hex")}.json`);
    fs.writeFileSync(leasePath, JSON.stringify({
      schema: "pi-iterative-goal.integration-lease.v1",
      repoRoot: fs.realpathSync(repo),
      branch,
      pid: 2_147_483_647,
      processStartToken: "provably-dead-fixture",
      nonce: "dead-owner",
      acquiredAt: new Date(0).toISOString(),
    }));
    recoverWorktrees(repo);
    assert.equal(fs.existsSync(leasePath), false);
    console.log("✓ scoped recovery reclaims a provably dead integration lease");
  }

  // 8. Dead worktree adoption requires the exact displaced lease nonce.
  {
    const repo = makeRepo("pi-ig-dead-owner-adopt-");
    const { stateManager, run } = makeState(repo, "dead owner adoption");
    const firstPlan = planFor(run.runId);
    ledgerPlan(stateManager, firstPlan);
    const first = await mergeShardPlan(firstPlan, inputsFor(repo, firstPlan, "adopt-1"), {
      stateManager,
      cwd: repo,
      config: mergeConfig,
      runTests: testsPass,
    });
    const survivor = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-integration-dead-owner-"));
    git(repo, ["worktree", "add", "-q", survivor, first.integrationBranch]);
    const commonDir = path.resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
    const leaseRoot = path.join(commonDir, "pi-iterative-goal", "integration-leases");
    fs.mkdirSync(leaseRoot, { recursive: true });
    const leasePath = path.join(leaseRoot, `${crypto.createHash("sha256").update(first.integrationBranch).digest("hex")}.json`);
    const deadNonce = "exact-dead-predecessor";
    const deadOwner = {
      pid: 2_147_483_647,
      processStartToken: "provably-dead-fixture",
    };
    fs.writeFileSync(leasePath, JSON.stringify({
      schema: "pi-iterative-goal.integration-lease.v1",
      repoRoot: fs.realpathSync(repo),
      branch: first.integrationBranch,
      ...deadOwner,
      nonce: deadNonce,
      acquiredAt: new Date(0).toISOString(),
    }));
    fs.writeFileSync(path.join(survivor, ".pi-ig-worktree.json"), JSON.stringify({
      schema: "pi-iterative-goal.worktree-owner.v2",
      ...deadOwner,
      kind: "integration",
      branch: first.integrationBranch,
      leaseNonce: deadNonce,
      createdAt: new Date(0).toISOString(),
    }));
    const secondPlan = planFor(run.runId, 2, "plan-dead-owner-adopt", [
      { id: "shard-bridge", index: 0, file: "src/bridge.mjs", rank: 500 },
    ]);
    ledgerPlan(stateManager, secondPlan);
    const report = await mergeShardPlan(secondPlan, inputsFor(repo, secondPlan, "adopt-2"), {
      stateManager,
      cwd: repo,
      config: mergeConfig,
      runTests: testsPass,
    });
    assert.deepEqual(report.verified, ["shard-bridge"]);
    assert.equal(fs.existsSync(survivor), false);
    assert.equal(fs.existsSync(leasePath), false);
    console.log("✓ exact dead-owner lease nonce permits safe fresh-worktree recovery");
  }

  console.log("\nWorkspace hardening smoke passed. ✓");
} finally {
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
