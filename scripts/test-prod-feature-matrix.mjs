#!/usr/bin/env node
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FEATURE_MATRIX_CALIBRATION_TASK_IDS,
  FEATURE_MATRIX_PLAN_ID,
  FEATURE_MATRIX_REVIEW_ROLES,
  FEATURE_MATRIX_REVIEW_TASK_IDS,
  FEATURE_MATRIX_SCHEDULER_TASK_IDS,
  PRODUCTION_FEATURE_PROFILES,
  buildFeatureBoundaryPromptContract,
  buildFeatureProfileSettings,
  evaluateFeatureProfileEvidence,
  featureProfileBudget,
  intervalsOverlap,
  loadStrictFeatureMatrixInvocations,
  requireFeatureProfile,
} from "./lib/prod-feature-matrix.mjs";

assert.deepEqual(PRODUCTION_FEATURE_PROFILES, ["off", "c1", "c1-c2", "c1-c2-c3", "c1-c2-c3-c4"]);
assert.throws(() => requireFeatureProfile("c2"), /unknown feature profile/,
  "dependency-invalid standalone C2 is not a production profile");
assert.equal(intervalsOverlap(
  { startedAt: "2026-07-20T00:00:00.000Z", finishedAt: "2026-07-20T00:00:02.000Z" },
  { startedAt: "2026-07-20T00:00:01.000Z", finishedAt: "2026-07-20T00:00:03.000Z" },
), true);
assert.equal(intervalsOverlap(
  { startedAt: "2026-07-20T00:00:00.000Z", finishedAt: "2026-07-20T00:00:01.000Z" },
  { startedAt: "2026-07-20T00:00:01.000Z", finishedAt: "2026-07-20T00:00:02.000Z" },
), false, "touching endpoints are sequential, not overlapping");

const iso = (second) => `2026-07-20T00:00:${String(second).padStart(2, "0")}.000Z`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const newFilePatch = (file, line) => [
  `diff --git a/${file} b/${file}`,
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  `+++ b/${file}`,
  "@@ -0,0 +1 @@",
  `+${line}`,
  "",
].join("\n");

const reviewTasks = FEATURE_MATRIX_REVIEW_TASK_IDS.map((taskId, index) => ({
  taskId,
  role: FEATURE_MATRIX_REVIEW_ROLES[taskId],
  mode: "parallel",
  status: "completed",
  routeId: "zai_glm_5_2",
  provider: "zai",
  requestedModel: "glm-5.2",
  startedAt: iso(index),
  finishedAt: iso(index + 3),
  usage: { turns: 1 },
}));
const plan = {
  id: FEATURE_MATRIX_PLAN_ID,
  cycle: 1,
  decision: "fan_out",
  decisionReason: "balanced 1/1",
  tasks: [
    { id: "feature-a", allowedPaths: [{ kind: "exact", path: "feature-a.txt" }] },
    { id: "feature-b", allowedPaths: [{ kind: "exact", path: "feature-b.txt" }] },
  ],
  shards: [
    { id: "shard-1", files: ["feature-a.txt"], taskIds: ["feature-a"], allowedPaths: [{ kind: "exact", path: "feature-a.txt" }] },
    { id: "shard-2", files: ["feature-b.txt"], taskIds: ["feature-b"], allowedPaths: [{ kind: "exact", path: "feature-b.txt" }] },
  ],
  cutWeight: 0,
  couplingDensity: 0,
  algorithm: {
    prior: "spectral-fiedler",
    priorSplit: "median",
    refinement: "kernighan-lin",
    bisections: 1,
    refinementPasses: 1,
    refinementEvaluatedSwaps: 1,
    initialCutWeight: 0,
  },
};
const calibrationTasks = FEATURE_MATRIX_CALIBRATION_TASK_IDS.map((taskId, index) => ({
  taskId,
  role: "Implementer",
  mode: "parallel",
  status: "completed",
  routeId: "zai_glm_5_2",
  provider: "zai",
  requestedModel: "glm-5.2",
  startedAt: iso(5 + index),
  finishedAt: iso(8 + index),
  usage: { turns: 1 },
}));
const schedulerTasks = FEATURE_MATRIX_SCHEDULER_TASK_IDS.map((taskId, index) => ({
  taskId,
  role: "Implementer",
  mode: "parallel",
  status: "completed",
  routeId: "zai_glm_5_2",
  provider: "zai",
  requestedModel: "glm-5.2",
  startedAt: iso(10 + index),
  finishedAt: iso(13 + index),
  usage: { turns: 1 },
}));
const patchContents = {
  ".pi/iterative-goal/runs/run-1/cycles/1/shards/shard-1.patch": newFilePatch("feature-a.txt", "alpha"),
  ".pi/iterative-goal/runs/run-1/cycles/1/shards/shard-2.patch": newFilePatch("feature-b.txt", "beta"),
};
const claims = ["shard-1", "shard-2"].map((shardId, index) => ({
  planId: FEATURE_MATRIX_PLAN_ID,
  shardId,
  status: "completed",
  rank: 2 - index,
  workerSlot: index,
  patchArtifactPath: Object.keys(patchContents)[index],
}));
const patchArtifacts = claims.map((claim) => ({
  shardId: claim.shardId,
  path: claim.patchArtifactPath,
  bytes: Buffer.byteLength(patchContents[claim.patchArtifactPath]),
  sha256: sha256(patchContents[claim.patchArtifactPath]),
}));
const commits = ["1".repeat(40), "2".repeat(40)];
const merges = ["shard-1", "shard-2"].map((shardId, index) => ({
  planId: FEATURE_MATRIX_PLAN_ID,
  shardId,
  status: "verified",
  patchArtifactPath: claims[index].patchArtifactPath,
  patchSha256: sha256(patchContents[claims[index].patchArtifactPath].trim()),
  gate: { allowlistOk: true, testsOk: true },
  integrationCommitSha: commits[index],
}));
const treeShas = ["a".repeat(40), "b".repeat(40)];
const commitTreeProofs = ["shard-1", "shard-2"].map((shardId, index) => ({
  method: "git-read-tree-apply-cached-write-tree",
  shardId,
  parentSha: index === 0 ? "0".repeat(40) : commits[index - 1],
  commitSha: commits[index],
  patchArtifactPath: patchArtifacts[index].path,
  patchSha256: patchArtifacts[index].sha256,
  actualTreeSha: treeShas[index],
  expectedTreeSha: treeShas[index],
}));
const invocation = (taskId, timeOffset = 1) => ({
  taskId,
  role: FEATURE_MATRIX_REVIEW_ROLES[taskId]
    ?? (taskId.startsWith("sched-") || taskId.includes("implementer-calibration") ? "Implementer" : "Reviewer"),
  routeId: "zai_glm_5_2",
  provider: "zai",
  requestedModel: "glm-5.2",
  responseModel: "glm-5.2",
  termination: "success",
  gateStatus: "PASS",
  errorCode: null,
  startedAt: iso(timeOffset),
  endedAt: iso(timeOffset + 2),
  turns: 1,
});
const coordinatorInvocation = (timeOffset) => ({
  taskId: null,
  role: "Coordinator",
  routeId: "zai_glm_5_2",
  provider: "zai",
  requestedModel: "glm-5.2",
  responseModel: "glm-5.2",
  termination: "success",
  gateStatus: "PASS",
  errorCode: null,
  startedAt: iso(timeOffset),
  endedAt: iso(timeOffset + 1),
  turns: 1,
});

const strictTelemetryInvocation = (runId, taskId, timeOffset) => ({
  schema: "pi-iterative-goal.model-invocation.v1",
  invocationId: `invocation-${taskId}`,
  runId,
  sessionId: null,
  cycle: 1,
  phase: "implement",
  phaseAttemptId: "phase-1",
  taskId,
  attempt: 1,
  role: FEATURE_MATRIX_REVIEW_ROLES[taskId] ?? "Implementer",
  workloadClass: "production-feature-matrix",
  fixtureHash: "a".repeat(64),
  routeId: "zai_glm_5_2",
  provider: "zai",
  requestedModel: "glm-5.2",
  responseModel: "glm-5.2",
  familyId: "glm-5.2",
  servingVariant: "standard",
  reasoningEffort: "high",
  serviceTier: null,
  fallbackReason: null,
  startedAt: iso(timeOffset),
  firstTokenAt: iso(timeOffset + 1),
  endedAt: iso(timeOffset + 2),
  latencyMs: 2_000,
  ttftMs: 1_000,
  outputTokensPerSecond: 12.5,
  inputTokens: 100,
  outputTokens: 25,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: null,
  costUsd: null,
  turns: 1,
  toolCallCount: 0,
  toolErrorCount: 0,
  termination: "success",
  gateStatus: "PASS",
  errorCode: null,
  requestDigest: "b".repeat(64),
  resultDigest: "c".repeat(64),
});

function strictManagedEvents(records, runId) {
  let previousHash = null;
  return records.map((metadata, index) => {
    const base = {
      schema: "pi-iterative-goal.log.v1",
      timestamp: iso(40 + index),
      sequence: index + 1,
      pid: 12345,
      stream: "model-invocations",
      scope: "model-telemetry",
      level: "info",
      message: "model invocation completed",
      runId,
      phaseAttemptId: metadata.phaseAttemptId,
      previousHash,
      metadata,
    };
    const hash = sha256(`${previousHash ?? "GENESIS"}\n${JSON.stringify(base)}`);
    previousHash = hash;
    return { ...base, hash };
  });
}

function writeStrictTelemetryFixture(root, runId, events, content = null) {
  const directory = path.join(root, ".pi", "iterative-goal", "managed", "telemetry", "invocations");
  fs.mkdirSync(directory, { recursive: true });
  const telemetryPath = path.join(directory, `${runId}.jsonl`);
  fs.writeFileSync(telemetryPath, content ?? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const tail = events.at(-1);
  fs.writeFileSync(`${telemetryPath}.head.json`, JSON.stringify({
    sequence: tail.sequence,
    hash: tail.hash,
    updatedAt: tail.timestamp,
  }));
  return telemetryPath;
}

function validEvidenceInput(depth) {
  const taskIds = [
    ...(depth >= 1 ? FEATURE_MATRIX_REVIEW_TASK_IDS : []),
    ...(depth >= 3 ? FEATURE_MATRIX_CALIBRATION_TASK_IDS : []),
    ...(depth >= 3 ? FEATURE_MATRIX_SCHEDULER_TASK_IDS : []),
  ];
  const events = [];
  if (depth >= 2) events.push({ type: "shard_plan_proposed", entry: { plan: structuredClone(plan) } });
  if (depth >= 3) {
    events.push(...["shard-1", "shard-2"].map((shardId, index) => ({
      type: "shard_claimed",
      planId: FEATURE_MATRIX_PLAN_ID,
      shardId,
      evidence: { strategy: "heft", rank: 2 - index, slot: index, shortlistSize: 2 },
    })));
  }
  if (depth >= 4) {
    events.push({ type: "merge_verified", planId: FEATURE_MATRIX_PLAN_ID, shardId: "shard-1", integrationCommitSha: commits[0] });
    events.push({ type: "merge_verified", planId: FEATURE_MATRIX_PLAN_ID, shardId: "shard-2", integrationCommitSha: commits[1] });
  }
  return {
    events,
    state: {
      status: "running",
      phase: depth === 0 ? "implement" : "validate",
      swarm: { tasks: structuredClone([
        ...(depth >= 1 ? reviewTasks : []),
        ...(depth >= 3 ? calibrationTasks : []),
        ...(depth >= 3 ? schedulerTasks : []),
      ]) },
      shards: {
        pendingPlan: null,
        plans: depth >= 2 ? [structuredClone(plan)] : [],
        claims: depth >= 3 ? structuredClone(claims) : [],
        merges: depth >= 4 ? structuredClone(merges) : [],
      },
    },
    patchArtifacts: depth >= 3 ? structuredClone(patchArtifacts) : [],
    patchContents: depth >= 3 ? structuredClone(patchContents) : {},
    workerInvocations: taskIds.map((taskId) => invocation(taskId, 1)),
    mainTurns: 2,
    coordinatorInvocations: [coordinatorInvocation(20), coordinatorInvocation(22)],
    deliveredFiles: depth >= 4 ? { "feature-a.txt": "alpha\n", "feature-b.txt": "beta\n" } : {},
    seedHeadSha: "0".repeat(40),
    deliveredHeadSha: depth >= 4 ? commits[1] : "0".repeat(40),
    commitParents: depth >= 4 ? {
      [commits[0]]: ["0".repeat(40)],
      [commits[1]]: [commits[0]],
    } : {},
    commitTreeProofs: depth >= 4 ? structuredClone(commitTreeProofs) : [],
    trackedWorktreeStatus: "",
    runtimeCommands: ["goal-start", "goal-status", "goal-authorize-release"],
    subagentToolCalls: [],
  };
}

for (const [depth, profile] of PRODUCTION_FEATURE_PROFILES.entries()) {
  const promptContract = buildFeatureBoundaryPromptContract(profile);
  const settings = buildFeatureProfileSettings(profile);
  assert.deepEqual([
    settings.swarm.enabled,
    settings.sharder.enabled,
    settings.scheduler.enabled,
    settings.mergeBack.enabled,
  ], [1, 2, 3, 4].map((campaign) => depth >= campaign));
  assert.equal(settings.scheduler.workerModelProfile, "zai_glm_5_2");
  assert.equal(promptContract.toolAllowlist.includes("goal_subagent"), depth >= 1,
    `${profile} subagent prompt/tool availability must match C1`);
  assert.equal(promptContract.toolAllowlist.includes("goal_post_shards"), depth >= 2,
    `${profile} shard prompt/tool availability must match C2`);
  assert.equal(promptContract.planActionIds.includes("parallel_review"), depth >= 1,
    `${profile} review stimulus must match C1`);
  assert.equal(promptContract.planActionIds.includes("post_shards"), depth >= 2,
    `${profile} shard stimulus must match C2`);
  const budget = featureProfileBudget(profile);
  assert.deepEqual(budget, depth === 4
    ? { maxMinutes: 20, maxModelResponses: 60, maxTokens: 500_000 }
    : { maxMinutes: 10, maxModelResponses: 24, maxTokens: 200_000 });

  const evidence = evaluateFeatureProfileEvidence(profile, validEvidenceInput(depth));
  assert.equal(evidence.status, "PASS", `${profile}: ${evidence.failedCheckIds.join(", ")}`);
}

const offPromptContract = buildFeatureBoundaryPromptContract("off");
assert.deepEqual(offPromptContract.planActionIds, ["update_task_plan", "report_phase_result"],
  "OFF prompt contract must not stimulate any C1-C4 feature action");
assert.doesNotMatch(offPromptContract.criterion, /parallel review|sequential worker|typed plan proposal/i,
  "OFF criterion must not request the feature evidence that zero-effect mode forbids");
assert.match(offPromptContract.criterion, /zero C1-C4 task, worker invocation, shard plan, claim, patch artifact, merge, feature event, or tracked-file effect/i);

const c1PromptContract = buildFeatureBoundaryPromptContract("c1");
assert.deepEqual(c1PromptContract.planActionIds,
  ["parallel_review", "update_task_plan", "report_phase_result"],
  "C1 prompt contract must stop before C2 shard-plan stimulus");
assert.ok(!c1PromptContract.toolAllowlist.includes("goal_post_shards"),
  "C1 tool surface must not expose the C2 shard-plan tool");

const coordinatorCountMismatch = validEvidenceInput(1);
coordinatorCountMismatch.coordinatorInvocations.pop();
let broken = evaluateFeatureProfileEvidence("c1", coordinatorCountMismatch);
assert.ok(broken.failedCheckIds.includes("coordinator_exact_invocation_count"),
  "coordinator telemetry count must equal observed main-session turns exactly");

const wrongCoordinatorIdentity = validEvidenceInput(1);
wrongCoordinatorIdentity.coordinatorInvocations[0].responseModel = "glm-4.7";
broken = evaluateFeatureProfileEvidence("c1", wrongCoordinatorIdentity);
assert.ok(broken.failedCheckIds.includes("coordinator_exact_zai_identity"),
  "every coordinator turn must prove the exact upstream Zai GLM-5.2 identity");

const sequential = validEvidenceInput(1);
sequential.state.swarm.tasks = sequential.state.swarm.tasks.map((task, index) => ({
  ...task,
  startedAt: iso(index * 3),
  finishedAt: iso(index * 3 + 1),
}));
broken = evaluateFeatureProfileEvidence("c1", sequential);
assert.equal(broken.status, "FAIL");
assert.ok(broken.failedCheckIds.includes("c1_parallel_intervals_overlap"));

const sequentialC1Telemetry = validEvidenceInput(1);
for (const [index, taskId] of FEATURE_MATRIX_REVIEW_TASK_IDS.entries()) {
  const invocationRecord = sequentialC1Telemetry.workerInvocations.find((item) => item.taskId === taskId);
  invocationRecord.startedAt = iso(index * 2);
  invocationRecord.endedAt = iso(index * 2 + 1);
}
broken = evaluateFeatureProfileEvidence("c1", sequentialC1Telemetry);
assert.ok(broken.failedCheckIds.includes("c1_parallel_intervals_overlap"),
  "an overlapping C1 ledger cannot certify sequential worker telemetry");

const sequentialC3Telemetry = validEvidenceInput(3);
for (const [index, taskId] of FEATURE_MATRIX_SCHEDULER_TASK_IDS.entries()) {
  const invocationRecord = sequentialC3Telemetry.workerInvocations.find((item) => item.taskId === taskId);
  invocationRecord.startedAt = iso(10 + index * 2);
  invocationRecord.endedAt = iso(11 + index * 2);
}
broken = evaluateFeatureProfileEvidence("c1-c2-c3", sequentialC3Telemetry);
assert.ok(broken.failedCheckIds.includes("c3_worker_intervals_overlap"),
  "an overlapping C3 ledger cannot certify sequential worker telemetry");

const wrongIdentity = validEvidenceInput(1);
wrongIdentity.workerInvocations[0].responseModel = "glm-4.7";
broken = evaluateFeatureProfileEvidence("c1", wrongIdentity);
assert.ok(broken.failedCheckIds.includes("workers_exact_zai_identity"), "wrong upstream model identity fails closed");

const missingIdentity = validEvidenceInput(1);
missingIdentity.workerInvocations[0].responseModel = null;
broken = evaluateFeatureProfileEvidence("c1", missingIdentity);
assert.ok(broken.failedCheckIds.includes("workers_exact_zai_identity"), "missing upstream model identity fails closed");

const missingInvocation = validEvidenceInput(1);
missingInvocation.workerInvocations.pop();
broken = evaluateFeatureProfileEvidence("c1", missingInvocation);
assert.ok(broken.failedCheckIds.includes("workers_exact_task_set"), "missing expected task telemetry fails closed");

const wrongStateRole = validEvidenceInput(1);
wrongStateRole.state.swarm.tasks[0].role = "Scout";
broken = evaluateFeatureProfileEvidence("c1", wrongStateRole);
assert.ok(broken.failedCheckIds.includes("state_exact_role_binding"), "state task IDs must bind to their exact intended roles");

const swappedWorkerRoles = validEvidenceInput(1);
[swappedWorkerRoles.workerInvocations[0].role, swappedWorkerRoles.workerInvocations[1].role] = [
  swappedWorkerRoles.workerInvocations[1].role,
  swappedWorkerRoles.workerInvocations[0].role,
];
broken = evaluateFeatureProfileEvidence("c1", swappedWorkerRoles);
assert.ok(broken.failedCheckIds.includes("workers_exact_role_binding"), "worker telemetry roles cannot be swapped across expected IDs");

const wrongBinding = validEvidenceInput(3);
wrongBinding.state.shards.claims[0].patchArtifactPath = "wrong.patch";
broken = evaluateFeatureProfileEvidence("c1-c2-c3", wrongBinding);
assert.ok(broken.failedCheckIds.includes("c3_patch_artifacts_bound"));

const duplicateShard = validEvidenceInput(3);
duplicateShard.state.shards.claims[1] = structuredClone(duplicateShard.state.shards.claims[0]);
duplicateShard.patchArtifacts[1] = structuredClone(duplicateShard.patchArtifacts[0]);
broken = evaluateFeatureProfileEvidence("c1-c2-c3", duplicateShard);
assert.ok(broken.failedCheckIds.includes("c3_claims_complete"), "duplicate claim shard cannot certify C3");
assert.ok(broken.failedCheckIds.includes("c3_complete_patch_artifacts"), "duplicate artifact shard cannot certify C3");

const wrongHash = validEvidenceInput(3);
wrongHash.patchArtifacts[0].sha256 = "f".repeat(64);
broken = evaluateFeatureProfileEvidence("c1-c2-c3", wrongHash);
assert.ok(broken.failedCheckIds.includes("c3_patch_hashes_match_content"));

const wrongContent = validEvidenceInput(3);
const firstPath = wrongContent.patchArtifacts[0].path;
wrongContent.patchContents[firstPath] = newFilePatch("feature-a.txt", "not-alpha");
wrongContent.patchArtifacts[0].bytes = Buffer.byteLength(wrongContent.patchContents[firstPath]);
wrongContent.patchArtifacts[0].sha256 = sha256(wrongContent.patchContents[firstPath]);
broken = evaluateFeatureProfileEvidence("c1-c2-c3", wrongContent);
assert.ok(broken.failedCheckIds.includes("c3_patch_contents_exact"));

const wrongDelivery = validEvidenceInput(4);
wrongDelivery.deliveredFiles["feature-a.txt"] = "not-alpha\n";
wrongDelivery.deliveredHeadSha = "9".repeat(40);
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", wrongDelivery);
assert.ok(broken.failedCheckIds.includes("c4_expected_files_delivered"));
assert.ok(broken.failedCheckIds.includes("c4_exact_delivered_sha"));

const duplicateMerge = validEvidenceInput(4);
duplicateMerge.state.shards.merges[1] = structuredClone(duplicateMerge.state.shards.merges[0]);
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", duplicateMerge);
assert.ok(broken.failedCheckIds.includes("c4_merges_verified"), "duplicate shard/commit records cannot certify C4");

const brokenMergeChain = validEvidenceInput(4);
brokenMergeChain.commitParents[commits[1]] = [brokenMergeChain.seedHeadSha];
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", brokenMergeChain);
assert.ok(broken.failedCheckIds.includes("c4_commit_chain_exact"), "two unrelated commits cannot certify the delivered chain");

const unboundMergePatch = validEvidenceInput(4);
unboundMergePatch.state.shards.merges[0].patchSha256 = "f".repeat(64);
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", unboundMergePatch);
assert.ok(broken.failedCheckIds.includes("c4_merge_patch_provenance"), "merge ledger must bind the exact captured patch and gate");

const wrongCommitTree = validEvidenceInput(4);
wrongCommitTree.commitTreeProofs[0].actualTreeSha = "c".repeat(40);
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", wrongCommitTree);
assert.ok(broken.failedCheckIds.includes("c4_commit_trees_match_exact_patch_application"),
  "a verified commit tree that differs from applying the exact patch to its parent fails closed");

const duplicateTreeProof = validEvidenceInput(4);
duplicateTreeProof.commitTreeProofs[1] = structuredClone(duplicateTreeProof.commitTreeProofs[0]);
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", duplicateTreeProof);
assert.ok(broken.failedCheckIds.includes("c4_commit_tree_proof_set_exact"),
  "duplicate shard/commit tree proof records cannot certify C4");

const unboundTreeProof = validEvidenceInput(4);
unboundTreeProof.commitTreeProofs[0].patchSha256 = "f".repeat(64);
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", unboundTreeProof);
assert.ok(broken.failedCheckIds.includes("c4_commit_tree_proof_set_exact"),
  "tree proof must bind the exact captured patch bytes");

const missingTreeProof = validEvidenceInput(4);
missingTreeProof.commitTreeProofs.pop();
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", missingTreeProof);
assert.ok(broken.failedCheckIds.includes("c4_commit_tree_proof_set_exact"),
  "missing tree proof cannot certify C4");

const dirtyOff = validEvidenceInput(0);
dirtyOff.state.phase = "plan";
dirtyOff.state.swarm.tasks = structuredClone(reviewTasks);
dirtyOff.events.push({ type: "shard_posted", shardPlan: { id: FEATURE_MATRIX_PLAN_ID } });
dirtyOff.workerInvocations.push(invocation("unexpected-worker"));
dirtyOff.state.shards.plans.push(structuredClone(plan));
dirtyOff.state.shards.claims.push(...structuredClone(claims));
dirtyOff.state.shards.merges.push(...structuredClone(merges));
dirtyOff.patchArtifacts.push(...structuredClone(patchArtifacts));
Object.assign(dirtyOff.patchContents, structuredClone(patchContents));
dirtyOff.deliveredHeadSha = "9".repeat(40);
dirtyOff.trackedWorktreeStatus = " M README.md";
broken = evaluateFeatureProfileEvidence("off", dirtyOff);
for (const checkId of [
  "workers_exact_task_set",
  "workers_exact_zai_identity",
  "c1_remains_disabled",
  "off_no_feature_tasks",
  "off_no_worker_telemetry",
  "c2_remains_disabled",
  "c3_remains_disabled",
  "c4_remains_disabled",
  "off_inert_boundary_reached",
  "off_no_feature_events",
  "off_no_feature_artifacts",
  "off_head_unchanged",
  "off_tracked_tree_clean",
  "tracked_worktree_clean_at_boundary",
]) assert.ok(broken.failedCheckIds.includes(checkId), `OFF negative evidence must fail ${checkId}`);

const dirtyAllOn = validEvidenceInput(4);
dirtyAllOn.trackedWorktreeStatus = " M README.md\n?? extra.txt";
broken = evaluateFeatureProfileEvidence("c1-c2-c3-c4", dirtyAllOn);
assert.ok(broken.failedCheckIds.includes("tracked_worktree_clean_at_boundary"),
  "enabled profiles cannot certify while unrelated tracked or untracked drift is present");

const { loadSchedulerConfig } = await import("../dist/kernel/scheduler.js");
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-prod-feature-settings-"));
try {
  fs.mkdirSync(path.join(settingsRoot, ".pi"));
  fs.writeFileSync(path.join(settingsRoot, ".pi", "settings.json"), JSON.stringify({
    iterativeGoal: { scheduler: { enabled: true, workerModelProfile: "zai_glm_5_2" } },
  }));
  assert.equal(loadSchedulerConfig(settingsRoot).workerModelProfile, "zai_glm_5_2");
  fs.writeFileSync(path.join(settingsRoot, ".pi", "settings.json"), JSON.stringify({
    iterativeGoal: { scheduler: { enabled: true, workerModelProfile: "unlisted/model" } },
  }));
  assert.equal(loadSchedulerConfig(settingsRoot).workerModelProfile, "unlisted/model",
    "an invalid explicit profile remains visible to requireModelRoute and is not silently substituted");
  for (const selector of [" zai_glm_5_2 ", ""]) {
    fs.writeFileSync(path.join(settingsRoot, ".pi", "settings.json"), JSON.stringify({
      iterativeGoal: { scheduler: { enabled: true, workerModelProfile: selector } },
    }));
    assert.equal(loadSchedulerConfig(settingsRoot).workerModelProfile, selector,
      "inexact explicit selector bytes remain visible to the fail-closed roster gate");
  }
} finally {
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

const overSuiteBudget = spawnSync(process.execPath, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "prod-feature-matrix.mjs"),
  "--max-model-calls-per-profile",
  "61",
], { encoding: "utf8" });
assert.notEqual(overSuiteBudget.status, 0, "no profile can exceed the all-on 60-response ceiling");
assert.match(`${overSuiteBudget.stdout}\n${overSuiteBudget.stderr}`, /integer from 1 through 60/s);

const ownedGroupSelfTest = spawnSync(process.execPath, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "prod-feature-matrix.mjs"),
  "--self-test-owned-group",
], { encoding: "utf8" });
assert.equal(ownedGroupSelfTest.status, 0,
  `owned-group self-test failed:\n${ownedGroupSelfTest.stdout}\n${ownedGroupSelfTest.stderr}`);
assert.match(ownedGroupSelfTest.stdout, /owned-group identity: PASS/);

const { executeShardPlan } = await import("../dist/kernel/scheduler.js");
const invalidDispatchState = {
  runId: "invalid-selector-run",
  swarm: { tasks: [] },
  shards: { plans: [], claims: [] },
};
let invalidPlanMutations = 0;
let invalidWorkerSpawns = 0;
await assert.rejects(executeShardPlan({ ...structuredClone(plan), runId: invalidDispatchState.runId }, {
  cwd: settingsRoot,
  stateManager: {
    getState: () => invalidDispatchState,
    recordShardPlan: () => { invalidPlanMutations += 1; },
  },
  pool: {
    submit: async () => { invalidWorkerSpawns += 1; throw new Error("must not spawn"); },
  },
  broker: {},
  backend: "test",
  detectedBackend: "test",
  config: {
    enabled: true,
    concurrency: 2,
    driftThreshold: 0.5,
    replanIntervalMs: 60_000,
    alpha: 1,
    beta: 1,
    workerModelProfile: " zai_glm_5_2 ",
  },
}), /Unlisted or inexact model selector/);
assert.equal(invalidPlanMutations, 0, "invalid scheduler selector cannot mutate the plan ledger");
assert.equal(invalidWorkerSpawns, 0, "invalid scheduler selector cannot spawn a worker");

const strictRunId = "matrix-telemetry-run";
const strictRecords = FEATURE_MATRIX_REVIEW_TASK_IDS.map((taskId, index) =>
  strictTelemetryInvocation(strictRunId, taskId, 1 + index));
const strictEvents = strictManagedEvents(strictRecords, strictRunId);
const strictRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-strict-matrix-telemetry-"));
try {
  writeStrictTelemetryFixture(strictRoot, strictRunId, strictEvents);
  assert.deepEqual(
    loadStrictFeatureMatrixInvocations(strictRoot, strictRunId).map((item) => item.taskId),
    FEATURE_MATRIX_REVIEW_TASK_IDS,
    "strict matrix telemetry accepts a complete schema-valid hash chain",
  );
} finally {
  fs.rmSync(strictRoot, { recursive: true, force: true });
}

function assertStrictTelemetryRejected(label, build, pattern) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ig-strict-matrix-${label}-`));
  try {
    build(root);
    assert.throws(() => loadStrictFeatureMatrixInvocations(root, strictRunId), pattern, label);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

assertStrictTelemetryRejected("malformed", (root) => {
  writeStrictTelemetryFixture(root, strictRunId, strictEvents,
    `${JSON.stringify(strictEvents[0])}\n{"broken"\n`);
}, /malformed matrix telemetry JSON/);

assertStrictTelemetryRejected("unterminated", (root) => {
  writeStrictTelemetryFixture(root, strictRunId, strictEvents,
    strictEvents.map((event) => JSON.stringify(event)).join("\n"));
}, /unterminated record/);

assertStrictTelemetryRejected("wrong-schema", (root) => {
  const wrongSchemaRecords = structuredClone(strictRecords);
  wrongSchemaRecords[1].schema = "pi-iterative-goal.model-invocation.v0";
  writeStrictTelemetryFixture(root, strictRunId, strictManagedEvents(wrongSchemaRecords, strictRunId));
}, /wrong model invocation schema/);

assertStrictTelemetryRejected("corrupt-sequence", (root) => {
  const corrupt = structuredClone(strictEvents);
  corrupt[1].sequence = 3;
  writeStrictTelemetryFixture(root, strictRunId, corrupt);
}, /sequence chain is corrupt/);

assertStrictTelemetryRejected("corrupt-hash", (root) => {
  const corrupt = structuredClone(strictEvents);
  corrupt[1].hash = "f".repeat(64);
  writeStrictTelemetryFixture(root, strictRunId, corrupt);
}, /hash chain is corrupt/);

console.log("prod-feature-matrix: PASS (OFF + cumulative profiles, strict chained telemetry, telemetry-bound overlap, bound patch bytes, merge delivery)");
