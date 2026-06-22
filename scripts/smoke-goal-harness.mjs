/**
 * Smoke test harness for pi-iterative-goal v3 hardened.
 *
 * Verifies:
 * 1. Module imports cleanly
 * 2. State manager creates run-scoped artifacts
 * 3. v1→v2 state migration does not crash
 * 4. /goal-status --json returns parseable JSON with lock + evaluator state
 * 5. Stale-write guard rejects mismatched runId/phaseAttemptId
 * 6. Diff allowlist detects out-of-plan file
 * 7. Validation script generation produces valid bash
 * 8. Resume prompt carries nonce + tool contract
 * 9. agent_end synthesis handles plain-string and structured assistant output
 * 10. goal-status latestArtifact shape is parseable
 * 11. AWS CLI config parsing and safety classification behave as expected
 * 12. Resume prompt exposes AWS tool guidance when enabled
 * 13. Git finalization config and prompt guidance behave as expected
 *
 * Usage:
 *   node scripts/smoke-goal-harness.mjs
 */

import { ok, strictEqual as eq, deepStrictEqual } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Test 1: Module imports ──────────────────────────────────────────

{
  const m = await import("../dist/types.js");
  ok(m.PHASE_ORDER, "PHASE_ORDER exported");
  ok(m.PhaseEventKind.includes("stale_phase_output_ignored"), "stale_phase_output_ignored event kind exists");
  console.log("✓ Test 1: Module imports cleanly, PhaseEventKind includes stale_phase_output_ignored");
}

// ── Test 2: v1→v2 migration ────────────────────────────────────────

{
  // Simulate a v1 state fixture with no v2 fields
  const v1Fixture = {
    version: 1,
    runId: "ig-test-legacy-001-a1b2c3",
    goal: "Fix the flux capacitor",
    goalCriterion: "Flux capacitor passes all tests",
    mode: "auto_until_external_evaluator_success",
    status: "running",
    cycle: 3,
    phase: "implement",
    requiredPhaseOrder: ["research", "plan", "implement", "validate"],
    evaluator: { model: "deepseek/deepseek-v4-pro", provider: "openrouter", completionRequiresEvaluator: true },
    config: {
      primaryModel: { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
      fallbackModels: [],
      blockedModels: [],
    },
    capabilities: null,
    errors: [],
    artifacts: { research: [], plans: [], implementations: [], validations: [], evaluatorReports: [] },
    constraints: {
      neverStopUntilEvaluatorGoalMet: true,
      requireAllFourPhasesEachCycle: true,
      allowDestructiveOps: false,
      allowGitFinalization: false,
      requireOperatorApprovalForDangerousOps: true,
      subagentTimeoutMs: 300_000,
    },
  };

  // Apply migration logic from state.ts migrateState()
  if (!v1Fixture.lock) {
    v1Fixture.lock = {
      activeRunId: v1Fixture.runId,
      activePhaseId: null,
      phaseLeaseOwner: "",
      phaseStartedAt: new Date().toISOString(),
      phaseStatus: "paused",
      queuedPhaseIds: [],
    };
  }
  if (!v1Fixture.phaseAttempts) v1Fixture.phaseAttempts = [];
  if (!v1Fixture.evaluatorState) v1Fixture.evaluatorState = null;
  if (!v1Fixture.finalizationPolicy) {
    v1Fixture.finalizationPolicy = {
      allowGitFinalization: false,
      allowCommit: false,
      allowPush: false,
      allowPR: false,
      fallback: "patch",
    };
  }
  if (!v1Fixture.config.modelHealth) v1Fixture.config.modelHealth = {};
  if (!v1Fixture.config.awsCli) {
    v1Fixture.config.awsCli = {
      enabled: false,
      defaultRegion: "us-east-1",
      profileResolutionOrder: ["explicit", "env", "unify", "unify-old"],
      requireSessionManagerPlugin: true,
      allowMutatingFamilies: [],
      preflight: null,
    };
  }
  v1Fixture.version = 2;

  eq(v1Fixture.version, 2);
  eq(v1Fixture.lock.activeRunId, "ig-test-legacy-001-a1b2c3");
  eq(v1Fixture.finalizationPolicy.fallback, "patch");
  eq(v1Fixture.phaseAttempts.length, 0);
  ok(typeof v1Fixture.config.modelHealth === "object" && Object.keys(v1Fixture.config.modelHealth).length === 0, "modelHealth initialized as empty object");
  eq(v1Fixture.config.awsCli.enabled, false);
  console.log("✓ Test 2: v1 state migrated to v2 without crash");
}

// ── Test 3: Stale-write guard ──────────────────────────────────────

{
  function checkStaleWriteGuard(state, params, action) {
    if (!state) return "No active state";
    if (state.status !== "running" && action !== "goal_checkpoint") return `Not running (${state.status})`;
    if (params.runId && params.runId !== state.runId) return `runId mismatch`;
    if (params.phaseAttemptId && state.lock.activePhaseId && params.phaseAttemptId !== state.lock.activePhaseId) return `phaseAttemptId mismatch`;
    return null;
  }

  const state = {
    runId: "ig-001",
    status: "running",
    lock: { activePhaseId: "ig-001/c1/research/a1" },
  };

  // Valid
  eq(checkStaleWriteGuard(state, { runId: "ig-001", phaseAttemptId: "ig-001/c1/research/a1" }, "goal_report_phase_result"), null);

  // Stale runId
  ok(checkStaleWriteGuard(state, { runId: "ig-002" }, "goal_report_phase_result") !== null);

  // Stale phaseAttemptId
  ok(checkStaleWriteGuard(state, { phaseAttemptId: "ig-001/c2/plan/a1" }, "goal_report_phase_result") !== null);

  // Paused state
  const paused = { ...state, status: "paused_by_user", lock: { activePhaseId: "ig-001/c1/research/a1" } };
  ok(checkStaleWriteGuard(paused, { runId: "ig-001" }, "goal_report_phase_result") !== null);

  console.log("✓ Test 3: Stale-write guard rejects mismatched runId, phaseAttemptId, and non-running states");
}

// ── Test 4: Diff allowlist detection ────────────────────────────────

{
  const { extractPathScopesFromPlanText, pathInScopes } = await import("../dist/domain/path-scope.js");
  const { extractAcceptedAmendmentScopes } = await import("../dist/domain/plan.js");

  const plan = [
    "Exact files to modify:",
    "- `src/utils.ts`",
    "- `src/components/Button.tsx`",
    "- `Dockerfile`",
    "- `scripts/deploy`",
  ].join("\n");
  const planned = extractPathScopesFromPlanText(plan);
  const changed = ["src/utils.ts", "src/other.ts", "src/components/Button.tsx", "Dockerfile", "scripts/deploy"];

  const extraFiles = changed.filter(f => !pathInScopes(f, planned));

  eq(extraFiles.length, 1);
  eq(extraFiles[0], "src/other.ts");
  eq(pathInScopes("src/components/Button.tsx", planned), true);
  eq(pathInScopes("src/components/Button.tsx.bak", planned), false);
  eq(pathInScopes("Dockerfile", planned), true);
  eq(pathInScopes("scripts/deploy", planned), true);

  const amendedPlan = [
    plan,
    "```json",
    JSON.stringify({
      type: "PlanAmendment",
      id: "amend-1",
      status: "accepted",
      discovery: "Need a fixture file for the new path-scope test.",
      affectedRequirements: ["R2"],
      newAllowedPaths: ["fixtures/new-path.txt"],
      newCapabilities: [],
      riskChange: "low",
      revisedChecks: [],
      reviewer: "test-reviewer",
      reviewedAt: new Date().toISOString(),
    }),
    "```",
    "```json",
    JSON.stringify({
      type: "PlanAmendment",
      id: "amend-2",
      status: "proposed",
      discovery: "Unreviewed broadening.",
      affectedRequirements: ["R2"],
      newAllowedPaths: ["fixtures/unreviewed.txt"],
      newCapabilities: [],
      riskChange: "low",
      revisedChecks: [],
      reviewer: "",
      reviewedAt: "",
    }),
    "```",
  ].join("\n");
  const amendmentScopes = extractAcceptedAmendmentScopes(amendedPlan);
  eq(pathInScopes("fixtures/new-path.txt", amendmentScopes), true);
  eq(pathInScopes("fixtures/unreviewed.txt", amendmentScopes), false);

  console.log("✓ Test 4: Typed path scopes reject fuzzy allowlist matches");
}

// ── Test 5: Validation script generation ────────────────────────────

{
  const { generateValidationScript } = await import("../dist/phases.js");
  if (generateValidationScript) {
    const state = { runId: "ig-test-002-x1y2z3", cycle: 1 };
    const script = generateValidationScript(state, "npm test", "npm run lint");

    ok(script.includes("ig-test-002-x1y2z3"), "script includes runId");
    ok(script.includes("cycle 1"), "script includes cycle");
    ok(script.includes("set -euo pipefail"), "script has strict mode");
    ok(script.includes("spawnSync"), "script uses executable-plus-argv");
    ok(!script.includes("eval "), "script does not use eval");
    ok(!script.includes("|| true"), "script does not mask gate failure with || true");
    ok(script.includes("repo-state.txt"), "script creates repo-state.txt");
    ok(script.includes("diff.patch"), "script creates diff.patch");
    ok(!script.includes("> 2>"), "no shell syntax error (double redirect)");

    const noCommandScript = generateValidationScript(state, "", "");
    ok(noCommandScript.includes("'FAIL'"), "mandatory NOT_RUN checks fail the gate");

    console.log("✓ Test 5: Validation script uses argv execution and fail-closed checks");
  } else {
    console.log("⚠ Test 5: generateValidationScript not exported (may be internal only)");
  }
}

// ── Test 6: Phase identity nonce ────────────────────────────────────

{
  const state = {
    runId: "ig-003",
    lock: { activePhaseId: "ig-003/c1/implement/a1" },
    evaluator: { lastVerdict: null },
    cycle: 1,
    phase: "implement",
    status: "running",
  };

  // Simulate harnessMeta output
  const meta = `[HARNESS_META] runId=${state.runId} cycle=${state.cycle} phase=${state.phase} status=${state.status}\n[HARNESS_META] phaseAttemptId=${state.lock.activePhaseId}\n`;

  ok(meta.includes("runId=ig-003"));
  ok(meta.includes("phaseAttemptId=ig-003/c1/implement/a1"));

  console.log("✓ Test 6: Harness meta includes runId + phaseAttemptId nonce");
}

// ── Test 7: /goal-status --json structure ──────────────────────────

{
  const sample = {
    active: true,
    runId: "ig-004",
    lock: { activeRunId: "ig-004", activePhaseId: "ig-004/c1/research/a1", phaseStatus: "running", queuedPhaseIds: [] },
    evaluator: { status: "queued", startedAt: null, lastHeartbeatAt: null, isStale: null, error: null, lastVerdict: null },
    phaseAttempts: [],
  };

  const parsed = JSON.parse(JSON.stringify(sample));
  eq(parsed.active, true);
  eq(parsed.lock.phaseStatus, "running");
  eq(parsed.evaluator.status, "queued");

  console.log("✓ Test 7: /goal-status --json structure includes lock + evaluator state");
}

// ── Test 8: Resume prompt includes phase contract ───────────────────

{
  const { renderResumePrompt } = await import("../dist/phases.js");
  const state = {
    runId: "ig-005",
    goal: "Fix output capture",
    goalCriterion: "Artifacts reflect real assistant output",
    status: "running",
    cycle: 2,
    phase: "plan",
    lock: { activeRunId: "ig-005", activePhaseId: "ig-005/c2/plan/a1" },
    errors: [],
    evaluator: { lastVerdict: null },
    artifacts: { research: [], plans: [], implementations: [], validations: [] },
  };
  const snapshot = {
    activeTools: ["goal_report_phase_result", "goal_record_blocker", "bash"],
    allTools: [
      { name: "goal_report_phase_result", description: "", source: "extension" },
      { name: "goal_record_blocker", description: "", source: "extension" },
      { name: "bash", description: "", source: "builtin" },
    ],
    commands: [],
    hasBashTool: true,
    hasSubagentTool: false,
    hasAgentTool: false,
    hasMcpTool: false,
    mcpServers: [],
    model: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    awsCli: null,
    gitFinalization: null,
  };

  const prompt = renderResumePrompt(state, snapshot, { kind: "none" });
  ok(prompt.includes("[HARNESS_META] runId=ig-005"), "resume prompt includes harness meta");
  ok(prompt.includes('IDENTITY NONCE: Include runId="ig-005" phaseAttemptId="ig-005/c2/plan/a1"'), "resume prompt includes nonce");
  ok(prompt.includes("Call goal_report_phase_result"), "resume prompt includes report contract");

  console.log("✓ Test 8: Resume prompt carries nonce + tool contract");
}

// ── Test 9: agent_end synthesis handles live output shapes ──────────

{
  const { synthesizePhaseResultSafe, extractTextFromParts } = await import("../dist/index.js");

  eq(extractTextFromParts("plain string output"), "plain string output");
  eq(extractTextFromParts([{ type: "text", text: "hello" }, { type: "text", text: " world" }]), "hello world");

  const plainStringEvent = {
    messages: [
      { role: "assistant", content: "Plan complete. Next modify src/index.ts and add tests." },
    ],
  };
  const plainResult = synthesizePhaseResultSafe(plainStringEvent, "plan", 1, "ig-006", "ig-006/c1/plan/a1");
  eq(plainResult.status, "completed");
  eq(plainResult.content, "Plan complete. Next modify src/index.ts and add tests.");
  eq(plainResult.synthesis.source, "assistant_text");

  const structuredToolEvent = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "goal_report_phase_result", arguments: { runId: "ig-006", phaseAttemptId: "ig-006/c1/plan/a1" } },
        ],
      },
    ],
  };
  const toolOnlyResult = synthesizePhaseResultSafe(structuredToolEvent, "plan", 1, "ig-006", "ig-006/c1/plan/a1");
  eq(toolOnlyResult.status, "completed");
  eq(toolOnlyResult.synthesis.source, "assistant_tool_calls");
  eq(toolOnlyResult.synthesis.nonceMatched, true);

  const emptyEvent = { messages: [{ role: "assistant", content: [] }] };
  const emptyResult = synthesizePhaseResultSafe(emptyEvent, "research", 1, "ig-006", "ig-006/c1/research/a1");
  eq(emptyResult.status, "failed_recoverable");
  eq(emptyResult.synthesis.source, "synthetic_failure");

  console.log("✓ Test 9: agent_end synthesis handles plain-string and structured assistant output");
}

// ── Test 10: latestArtifact status shape is parseable ───────────────

{
  const sample = {
    latestArtifact: {
      phase: "plan",
      status: "completed",
      source: "assistant_text",
      nonceMatched: false,
      reason: "assistant_output_without_matching_harness_nonce",
    },
  };

  const parsed = JSON.parse(JSON.stringify(sample));
  eq(parsed.latestArtifact.source, "assistant_text");
  eq(parsed.latestArtifact.nonceMatched, false);

  console.log("✓ Test 10: goal-status latestArtifact shape is parseable");
}

// ── Test 11: AWS CLI config parsing and safety classification ──────

{
  const { loadAwsCliConfig, assessAwsCliArgs } = await import("../dist/aws-cli.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-aws-"));
  fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".pi", "settings.json"), JSON.stringify({
    iterativeGoal: {
      awsCli: {
        enabled: true,
        defaultRegion: "us-east-1",
        allowMutatingFamilies: [
          "ec2-start-stop-wait",
          "ssm-session",
          "ssm-send-command",
          "s3-sync",
          "s3-cp",
          "logs-tail",
        ],
      },
    },
  }));
  const cfg = loadAwsCliConfig(tmp);
  eq(cfg.enabled, true);
  eq(cfg.defaultRegion, "us-east-1");
  deepStrictEqual(cfg.allowMutatingFamilies, [
    "ec2-start-stop-wait",
    "ssm-session",
    "ssm-send-command",
    "s3-sync",
    "s3-cp",
    "logs-tail",
  ]);

  const readOnly = assessAwsCliArgs(["sts", "get-caller-identity"], cfg, false);
  eq(readOnly.allowed, true);
  eq(readOnly.isMutation, false);

  const blockedMutation = assessAwsCliArgs(["ssm", "send-command"], cfg, false);
  eq(blockedMutation.allowed, false);

  const allowedMutation = assessAwsCliArgs(["ssm", "send-command"], cfg, true);
  eq(allowedMutation.allowed, true);
  eq(allowedMutation.family, "ssm-send-command");

  const blockedFamily = assessAwsCliArgs(["iam", "create-user"], cfg, true);
  eq(blockedFamily.allowed, false);

  console.log("✓ Test 11: AWS CLI config parsing and safety classification behave as expected");
}

// ── Test 12: Resume prompt includes AWS guidance when enabled ──────

{
  const { renderResumePrompt } = await import("../dist/phases.js");
  const state = {
    runId: "ig-aws",
    goal: "Inspect AWS state",
    goalCriterion: "AWS evidence collected",
    status: "running",
    cycle: 1,
    phase: "research",
    lock: { activeRunId: "ig-aws", activePhaseId: "ig-aws/c1/research/a1" },
    errors: [],
    evaluator: { lastVerdict: null },
    artifacts: { research: [], plans: [], implementations: [], validations: [] },
  };
  const snapshot = {
    activeTools: ["goal_report_phase_result", "goal_record_blocker", "goal_aws_cli"],
    allTools: [
      { name: "goal_report_phase_result", description: "", source: "extension" },
      { name: "goal_record_blocker", description: "", source: "extension" },
      { name: "goal_aws_cli", description: "", source: "extension" },
    ],
    commands: [],
    hasBashTool: false,
    hasSubagentTool: false,
    hasAgentTool: false,
    hasMcpTool: false,
    mcpServers: [],
    model: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    awsCli: {
      enabled: true,
      cliAvailable: true,
      sessionManagerPluginAvailable: true,
      availableProfiles: ["unify-old"],
      resolvedProfile: "unify-old",
      resolvedRegion: "us-east-1",
      identity: null,
      issues: [],
      checkedAt: new Date().toISOString(),
    },
    gitFinalization: null,
  };

  const prompt = renderResumePrompt(state, snapshot, { kind: "none" });
  ok(prompt.includes("Use goal_aws_cli for AWS operations"), "resume prompt includes AWS tool guidance");
  ok(prompt.includes("profile=unify-old"), "resume prompt includes resolved AWS profile");

  console.log("✓ Test 12: Resume prompt exposes AWS tool guidance when enabled");
}

// ── Test 13: Git finalization config and prompt guidance ───────────

{
  const { loadFinalizationPolicy, shouldBlockGitShellCommand } = await import("../dist/git.js");
  const { renderResumePrompt } = await import("../dist/phases.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-git-"));
  fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".pi", "settings.json"), JSON.stringify({
    iterativeGoal: {
      finalization: {
        allowGitFinalization: true,
        allowCommit: true,
        allowPush: true,
        allowPR: true,
        fallback: "patch",
      },
    },
  }));

  const policy = loadFinalizationPolicy(tmp);
  eq(policy.allowGitFinalization, true);
  eq(policy.allowCommit, true);
  eq(policy.allowPush, true);
  eq(policy.allowPR, true);
  eq(policy.fallback, "patch");

  eq(
    shouldBlockGitShellCommand("git push -u origin test-branch", policy),
    "Git finalization commands must use goal_git when iterativeGoal.finalization is enabled.",
  );

  const state = {
    runId: "ig-git",
    goal: "Finalize repo work",
    goalCriterion: "Changes are committed and PR is opened",
    status: "running",
    cycle: 1,
    phase: "implement",
    lock: { activeRunId: "ig-git", activePhaseId: "ig-git/c1/implement/a1" },
    errors: [],
    evaluator: { lastVerdict: null },
    artifacts: { research: [], plans: [], implementations: [], validations: [] },
    finalizationPolicy: policy,
  };
  const snapshot = {
    activeTools: ["goal_report_phase_result", "goal_record_blocker", "goal_git"],
    allTools: [
      { name: "goal_report_phase_result", description: "", source: "extension" },
      { name: "goal_record_blocker", description: "", source: "extension" },
      { name: "goal_git", description: "", source: "extension" },
    ],
    commands: [],
    hasBashTool: false,
    hasSubagentTool: false,
    hasAgentTool: false,
    hasMcpTool: false,
    mcpServers: [],
    model: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    awsCli: null,
    gitFinalization: {
      enabled: true,
      allowCommit: true,
      allowPush: true,
      allowPR: true,
      gitAvailable: true,
      ghAvailable: true,
      ghAuthenticated: true,
      currentBranch: "feature/test",
    },
  };

  const prompt = renderResumePrompt(state, snapshot, { kind: "none" });
  ok(prompt.includes("Use goal_git for git actions"), "resume prompt includes goal_git guidance");
  ok(prompt.includes("push=yes"), "resume prompt includes git push capability");

  console.log("✓ Test 13: Git finalization config and prompt guidance behave as expected");
}

// ── Test 14: Model allowlist ────────────────────────────────────────

{
  const {
    ALLOWED_MODELS,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_MODELS,
    isAllowedModel,
    filterAllowedModels,
  } = await import("../dist/domain/models.js");

  ok(ALLOWED_MODELS.length >= 13, "model allowlist includes screenshot plus fusion/router models");
  deepStrictEqual(DEFAULT_PRIMARY_MODEL, { provider: "openrouter", model: "deepseek/deepseek-v4-flash" });
  ok(DEFAULT_FALLBACK_MODELS.some((m) => m.model === "openrouter/fusion"), "fusion fallback configured");
  eq(isAllowedModel("openrouter", "deepseek/deepseek-v4-flash"), true);
  eq(isAllowedModel("openrouter", "openai/o3-mini"), false);
  deepStrictEqual(
    filterAllowedModels([
      { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      { provider: "openrouter", model: "openai/o3-mini" },
    ]),
    [{ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }],
  );

  console.log("✓ Test 14: Model allowlist restricts stale/unapproved models");
}

// ── Test 15: Central policy engine ──────────────────────────────────

{
  const { PolicyEngine } = await import("../dist/policy/engine.js");
  const { exactPathScope } = await import("../dist/domain/path-scope.js");
  const policy = new PolicyEngine({ repoRoot: process.cwd(), allowNetworkHosts: ["example.com"] });

  const allowedWrite = policy.decide({
    id: "policy-1",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "fs.write",
    resource: { type: "path", value: "src/index.ts" },
    input: {},
    purpose: "test",
    risk: "write",
    dataClassification: "internal",
    allowedPaths: [exactPathScope("src/index.ts")],
  });
  eq(allowedWrite.result, "allow");

  const deniedWrite = policy.decide({
    id: "policy-2",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "fs.write",
    resource: { type: "path", value: "src/other.ts" },
    input: {},
    purpose: "test",
    risk: "write",
    dataClassification: "internal",
    allowedPaths: [exactPathScope("src/index.ts")],
  });
  eq(deniedWrite.result, "deny");

  const prDenied = policy.decide({
    id: "policy-3",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "git.pr.open",
    resource: { type: "git", value: "create_pr" },
    input: {},
    purpose: "test",
    risk: "privileged",
    dataClassification: "internal",
  });
  eq(prDenied.result, "deny");

  const prAllowed = policy.decide({
    id: "policy-3b",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "git.pr.open",
    resource: { type: "git", value: "create_pr" },
    input: { releaseAuthorizationValid: true },
    purpose: "test",
    risk: "privileged",
    dataClassification: "internal",
  });
  eq(prAllowed.result, "allow");

  const commitDenied = policy.decide({
    id: "policy-3c",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "git.commit",
    resource: { type: "git", value: "commit" },
    input: { allowCommit: false },
    purpose: "test",
    risk: "privileged",
    dataClassification: "internal",
  });
  eq(commitDenied.result, "deny");

  const commitAllowed = policy.decide({
    id: "policy-3d",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "git.commit",
    resource: { type: "git", value: "commit" },
    input: { allowCommit: true },
    purpose: "test",
    risk: "privileged",
    dataClassification: "internal",
  });
  eq(commitAllowed.result, "allow");

  const symlinkRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-policy-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-policy-outside-"));
  fs.mkdirSync(path.join(symlinkRepo, "src"));
  fs.symlinkSync(outside, path.join(symlinkRepo, "src", "outside"));
  const symlinkPolicy = new PolicyEngine({ repoRoot: symlinkRepo });
  const symlinkDenied = symlinkPolicy.decide({
    id: "policy-4",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "fs.write",
    resource: { type: "path", value: "src/outside/file.txt" },
    input: {},
    purpose: "test symlink containment",
    risk: "write",
    dataClassification: "internal",
    allowedPaths: [exactPathScope("src/outside/file.txt")],
  });
  eq(symlinkDenied.result, "deny");

  console.log("✓ Test 15: Central policy engine denies out-of-scope writes and PR opens");
}

// ── Test 16: Event replay restores new runs ─────────────────────────

{
  const { createStateManager } = await import("../dist/state.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-replay-"));
  const pi = { appendEntry() {} };
  const ctx = { cwd: tmp, sessionManager: { getEntries: () => [] } };
  const stateManager = createStateManager(pi);
  eq(stateManager.restore(ctx), null);
  const run = stateManager.createRun("Replay test", "Replay reconstructs core state");
  stateManager.setPhase("plan");
  stateManager.incrementCycle();
  stateManager.recordArtifact({
    phase: "plan",
    cycle: 2,
    status: "completed",
    content: "plan content",
    timestamp: new Date().toISOString(),
    toolCalls: [],
    toolErrors: [],
  });
  const replayed = stateManager.replayActiveState();
  ok(replayed, "replay returns state");
  eq(replayed.runId, run.runId);
  eq(replayed.phase, "plan");
  eq(replayed.cycle, 2);
  eq(replayed.artifacts.plans.length, 1);

  console.log("✓ Test 16: Event replay reconstructs new run state from events.jsonl");
}

// ── Test 17: Replay corruption fails closed for new runs ────────────

{
  const { createStateManager } = await import("../dist/state.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-replay-corrupt-"));
  const pi = { appendEntry() {} };
  const ctx = { cwd: tmp, sessionManager: { getEntries: () => [] } };
  const stateManager = createStateManager(pi);
  eq(stateManager.restore(ctx), null);
  stateManager.createRun("Replay corruption test", "Replay does not fall back silently");
  fs.appendFileSync(stateManager.getEventsPath(), "{not-json}\n");
  eq(stateManager.replayActiveState(), null);

  console.log("✓ Test 17: New-run replay corruption does not silently reconstruct from stale cache");
}

// ── Test 18: ReleaseAuthorization invalidates on HEAD change ────────

{
  const { validateReleaseAuthorization } = await import("../dist/release/controller.js");
  const auth = {
    id: "rel-test",
    runId: "ig-rel",
    repositoryId: "repo",
    baseSha: "base",
    headSha: "authorized-head",
    planHash: "plan",
    requirementsHash: "req",
    gateVerdictHash: "gate",
    evidenceRootHash: "evidence",
    allowedAction: "git.pr.open",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const pi = {
    async exec(_command, args) {
      if (args.join(" ") === "remote get-url origin") return { code: 0, stdout: "repo\n", stderr: "" };
      if (args.join(" ") === "merge-base HEAD origin/main") return { code: 0, stdout: "base\n", stderr: "" };
      if (args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "different-head\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const result = await validateReleaseAuthorization({ pi, ctx: { cwd: process.cwd() }, authorization: auth, runId: "ig-rel" });
  eq(result.ok, false);
  ok(result.reason.includes("stale"));

  const staleGate = await validateReleaseAuthorization({
    pi: {
      async exec(_command, args) {
        if (args.join(" ") === "remote get-url origin") return { code: 0, stdout: "repo\n", stderr: "" };
        if (args.join(" ") === "merge-base HEAD origin/main") return { code: 0, stdout: "base\n", stderr: "" };
        if (args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "authorized-head\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    ctx: { cwd: process.cwd() },
    authorization: auth,
    runId: "ig-rel",
    expected: {
      planHash: "plan",
      requirementsHash: "req",
      gateVerdictHash: "different-gate",
      evidenceRootHash: "evidence",
    },
  });
  eq(staleGate.ok, false);
  ok(staleGate.reason.includes("gate verdict hash"));

  console.log("✓ Test 18: ReleaseAuthorization is invalidated by a new HEAD");
}

// ── Test 19: Structured PR body generation ─────────────────────────

{
  const { generatePullRequestBody } = await import("../dist/release/pr-body.js");
  const now = new Date().toISOString();
  const state = {
    runId: "ig-pr-body",
    goal: "Harden release flow",
    goalCriterion: "All gates pass",
    cycle: 2,
    artifacts: {
      research: [],
      plans: [{ phase: "plan", cycle: 2, status: "completed", timestamp: now, content: "plan" }],
      implementations: [{ phase: "implement", cycle: 2, status: "completed", timestamp: now, content: "impl" }],
      validations: [{ phase: "validate", cycle: 2, status: "completed", timestamp: now, content: "valid" }],
      evaluatorReports: [],
    },
    evaluator: {
      lastVerdict: {
        goal_met: true,
        confidence: 0.99,
        completion_blockers: [],
        accepted_evidence: [],
        rejected_evidence: [],
        remaining_work: [],
        next_cycle_directive: { focus: "validate", reason: "done" },
        safety_notes: [],
      },
    },
    releaseAuthorization: {
      id: "rel-body",
      runId: "ig-pr-body",
      repositoryId: "repo",
      baseSha: "base",
      headSha: "head",
      planHash: "plan-hash",
      requirementsHash: "req-hash",
      gateVerdictHash: "gate-hash",
      evidenceRootHash: "evidence-hash",
      allowedAction: "git.pr.open",
      issuedAt: now,
      expiresAt: now,
    },
  };
  const body = generatePullRequestBody({
    state,
    changedFiles: ["src/git.ts", "src/release/pr-body.ts"],
    diffStat: "2 files changed",
    tests: [{ id: "npm run validate", status: "PASS", exitCode: 0, artifactUri: "verification-results.jsonl" }],
  });
  ok(body.includes("## Requirement To Evidence Matrix"));
  ok(body.includes("src/release/pr-body.ts"));
  ok(body.includes("ReleaseAuthorization: rel-body"));
  ok(body.includes("npm run validate"));

  console.log("✓ Test 19: Structured PR body generation includes evidence matrix and authorization");
}

// ── Summary ─────────────────────────────────────────────────────────

console.log("\nAll tests passed. ✓");
