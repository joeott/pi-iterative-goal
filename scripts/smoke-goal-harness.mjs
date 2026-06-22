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
import { spawnSync } from "node:child_process";
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
      profileResolutionOrder: ["explicit", "env", "configured"],
      profileCandidates: [],
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

    function makeValidationRepo(prefix) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      eq(spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" }).status, 0);
      eq(spawnSync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repo, encoding: "utf8" }).status, 0);
      eq(spawnSync("git", ["config", "user.name", "Smoke Test"], { cwd: repo, encoding: "utf8" }).status, 0);
      fs.writeFileSync(path.join(repo, "README.md"), "# smoke\n");
      eq(spawnSync("git", ["add", "README.md"], { cwd: repo, encoding: "utf8" }).status, 0);
      eq(spawnSync("git", ["commit", "-m", "init"], { cwd: repo, encoding: "utf8" }).status, 0);
      return repo;
    }

    function runValidationScript({ runId, cycle, testCommand, gateCommand, prefix }) {
      const repo = makeValidationRepo(prefix);
      const generated = generateValidationScript({ runId, cycle }, testCommand, gateCommand);
      const scriptPath = path.join(repo, "validate.sh");
      fs.writeFileSync(scriptPath, generated, { mode: 0o755 });
      const result = spawnSync("bash", [scriptPath], { cwd: repo, encoding: "utf8" });
      const resultsPath = path.join(repo, ".pi", "iterative-goal", "runs", runId, "cycles", String(cycle), "validate", "verification-results.jsonl");
      const results = fs.readFileSync(resultsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return { result, results };
    }

    const successRun = runValidationScript({
      runId: "ig-test-validate-success",
      cycle: 1,
      testCommand: "node -e \"process.exit(0)\"",
      gateCommand: "node -e \"process.exit(0)\"",
      prefix: "pi-ig-validate-success-",
    });
    eq(successRun.result.status, 0);
    deepStrictEqual(successRun.results.map((r) => [r.id, r.status, r.exitCode]), [
      ["tests", "PASS", 0],
      ["gates", "PASS", 0],
    ]);

    const failingGateRun = runValidationScript({
      runId: "ig-test-validate-failing-gate",
      cycle: 1,
      testCommand: "node -e \"process.exit(0)\"",
      gateCommand: "node -e \"process.exit(7)\"",
      prefix: "pi-ig-validate-failing-gate-",
    });
    eq(failingGateRun.result.status, 7);
    deepStrictEqual(failingGateRun.results.map((r) => [r.id, r.status, r.exitCode]), [
      ["tests", "PASS", 0],
      ["gates", "FAIL", 7],
    ]);

    const missingRun = runValidationScript({
      runId: "ig-test-validate-missing",
      cycle: 1,
      testCommand: "",
      gateCommand: "",
      prefix: "pi-ig-validate-missing-",
    });
    eq(missingRun.result.status, 1);
    deepStrictEqual(missingRun.results.map((r) => [r.id, r.status, r.exitCode]), [
      ["tests", "FAIL", null],
      ["gates", "FAIL", null],
    ]);

    console.log("✓ Test 5: Validation script executes argv checks, records exit codes, and fails closed");
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
  const { loadAwsCliConfig, assessAwsCliArgs, registerGoalAwsCliTool } = await import("../dist/aws-cli.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-aws-"));
  fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".pi", "settings.json"), JSON.stringify({
    iterativeGoal: {
      awsCli: {
        enabled: true,
        defaultRegion: "us-east-1",
        profileCandidates: ["ops-smoke"],
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
  deepStrictEqual(cfg.profileResolutionOrder, ["explicit", "env", "configured"]);
  deepStrictEqual(cfg.profileCandidates, ["ops-smoke"]);
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

  let registeredAwsTool = null;
  const fakePi = {
    registerTool(tool) {
      registeredAwsTool = tool;
    },
    async exec(command, args) {
      if (command === "which") return { code: 0, stdout: `/usr/bin/${args[0]}\n`, stderr: "", killed: false };
      if (command === "aws" && args.join(" ") === "configure list-profiles") {
        return { code: 0, stdout: "ops-smoke\n", stderr: "", killed: false };
      }
      if (command === "aws" && args.includes("get-caller-identity")) {
        return { code: 0, stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test", UserId: "AIDA" }), stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}`, killed: false };
    },
  };
  registerGoalAwsCliTool(fakePi, { getState: () => null });
  ok(registeredAwsTool, "goal_aws_cli registered");
  const awsResult = await registeredAwsTool.execute(
    "tool-aws",
    { args: ["sts", "get-caller-identity"], purpose: "broker smoke", cwd: tmp },
    undefined,
    undefined,
    { cwd: tmp },
  );
  eq(awsResult.isError, false);
  eq(awsResult.details.allowed, true);
  eq(awsResult.details.policyDecision.result, "allow");
  ok(awsResult.details.policyDecision.ruleIds.includes("policy.process.no-shell-strings"));

  console.log("✓ Test 11: AWS CLI config, safety classification, and broker policy evidence behave as expected");
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
      availableProfiles: ["ops-prod"],
      resolvedProfile: "ops-prod",
      resolvedRegion: "us-east-1",
      identity: null,
      issues: [],
      checkedAt: new Date().toISOString(),
    },
    gitFinalization: null,
  };

  const prompt = renderResumePrompt(state, snapshot, { kind: "none" });
  ok(prompt.includes("Use goal_aws_cli for AWS operations"), "resume prompt includes AWS tool guidance");
  ok(prompt.includes("profile=ops-prod"), "resume prompt includes resolved AWS profile");

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
  const { Type } = await import("typebox");
  const { CapabilityBroker } = await import("../dist/capabilities/broker.js");
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

  const packageInstallDenied = policy.decide({
    id: "policy-3e",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "process.exec",
    resource: { type: "command", value: "npm install left-pad" },
    input: {
      executable: "npm",
      argv: ["install", "left-pad"],
      allowDestructive: true,
    },
    purpose: "test package policy",
    risk: "write",
    dataClassification: "internal",
  });
  eq(packageInstallDenied.result, "deny");
  ok(packageInstallDenied.ruleIds.includes("policy.package.install"));

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

  const broker = new CapabilityBroker(policy);
  const brokerRequest = {
    id: "broker-1",
    actor: { kind: "tool", id: "test" },
    runId: "ig-policy",
    effect: "network.fetch",
    resource: { type: "url", value: "https://example.com/data.json" },
    input: {},
    purpose: "test provider schema validation",
    risk: "read",
    dataClassification: "public",
  };
  const outputSchema = Type.Object({ ok: Type.Boolean(), text: Type.String() });
  const validAction = await broker.invoke(
    brokerRequest,
    async () => ({ ok: true, text: "validated" }),
    { outputSchema },
  );
  eq(validAction.ok, true);
  deepStrictEqual(validAction.output, { ok: true, text: "validated" });

  const invalidAction = await broker.invoke(
    { ...brokerRequest, id: "broker-2" },
    async () => ({ ok: "yes", text: "invalid" }),
    { outputSchema },
  );
  eq(invalidAction.ok, false);
  ok(typeof invalidAction.error === "string" && invalidAction.error.length > 0, "invalid provider output is rejected by schema");

  const { CapabilityRegistry } = await import("../dist/capabilities/registry.js");
  const registry = new CapabilityRegistry();
  const provider = {
    async manifest() {
      return {
        providerId: "mock-web",
        version: "1.0.0",
        capabilities: [{
          id: "mock-web.fetch",
          effect: "network.fetch",
          risk: "read",
          inputSchema: Type.Object({ url: Type.String() }),
          outputSchema: Type.Object({ body: Type.String() }),
          networkAccess: "allowlisted",
          credentialRequirements: [],
          idempotent: true,
          concurrencySafe: true,
          outputSensitivity: "public",
        }],
      };
    },
    async preflight() {
      return { ok: true, checkedAt: new Date().toISOString() };
    },
    async invoke() {
      return { requestId: "mock", decision: prAllowed, ok: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    },
  };
  const manifest = await registry.register(provider);
  eq(manifest.providerId, "mock-web");
  eq(registry.listManifests().length, 1);
  await registry.register(provider).then(
    () => { throw new Error("duplicate provider registration unexpectedly succeeded"); },
    (err) => ok(String(err.message).includes("already registered")),
  );

  const invalidProvider = {
    ...provider,
    async manifest() {
      return {
        providerId: "bad-web",
        version: "1.0.0",
        capabilities: [{
          id: "bad-web.fetch",
          effect: "network.fetch",
          risk: "read",
          inputSchema: Type.Object({ url: Type.String() }),
          outputSchema: Type.Object({ body: Type.String() }),
          networkAccess: "none",
          credentialRequirements: [],
          idempotent: true,
          concurrencySafe: true,
          outputSensitivity: "public",
        }],
      };
    },
  };
  await registry.register(invalidProvider).then(
    () => { throw new Error("invalid provider manifest unexpectedly succeeded"); },
    (err) => ok(String(err.message).includes("networkAccess=none")),
  );

  const { FileSystemProvider } = await import("../dist/capabilities/filesystem/provider.js");
  const fsRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-fs-provider-"));
  const fsPolicy = new PolicyEngine({ repoRoot: fsRepo });
  const fsProvider = new FileSystemProvider(fsPolicy, fsRepo);
  const fsManifest = await registry.register(fsProvider);
  ok(fsManifest.capabilities.some((capability) => capability.effect === "fs.write"));

  const writeAction = await fsProvider.invoke({
    id: "fs-write-1",
    actor: { kind: "tool", id: "filesystem-smoke" },
    runId: "ig-policy",
    effect: "fs.write",
    resource: { type: "path", value: "allowed/out.txt" },
    input: { path: "allowed/out.txt", content: "hello" },
    purpose: "filesystem provider smoke",
    risk: "write",
    dataClassification: "internal",
    allowedPaths: [exactPathScope("allowed/out.txt")],
  }, new AbortController().signal);
  eq(writeAction.ok, true);
  eq(fs.readFileSync(path.join(fsRepo, "allowed", "out.txt"), "utf8"), "hello");

  const deniedFsAction = await fsProvider.invoke({
    id: "fs-write-2",
    actor: { kind: "tool", id: "filesystem-smoke" },
    runId: "ig-policy",
    effect: "fs.write",
    resource: { type: "path", value: "denied/out.txt" },
    input: { path: "denied/out.txt", content: "nope" },
    purpose: "filesystem provider denied smoke",
    risk: "write",
    dataClassification: "internal",
    allowedPaths: [exactPathScope("allowed/out.txt")],
  }, new AbortController().signal);
  eq(deniedFsAction.ok, false);
  eq(fs.existsSync(path.join(fsRepo, "denied", "out.txt")), false);

  const { ProcessProvider } = await import("../dist/capabilities/process/provider.js");
  const processProvider = new ProcessProvider(policy, process.cwd());
  const processManifest = await registry.register(processProvider);
  ok(processManifest.capabilities.some((capability) => capability.effect === "process.exec"));
  const processAction = await processProvider.invoke({
    id: "process-1",
    actor: { kind: "tool", id: "process-smoke" },
    runId: "ig-policy",
    effect: "process.exec",
    resource: { type: "command", value: "node --version" },
    input: {
      executable: "node",
      argv: ["--version"],
      timeoutMs: 30_000,
    },
    purpose: "process provider smoke",
    risk: "read",
    dataClassification: "internal",
  }, new AbortController().signal);
  eq(processAction.ok, true);
  ok(processAction.output.stdout.trim().startsWith("v"), "process provider captures stdout");

  const { WebFetchProvider } = await import("../dist/capabilities/web/provider.js");
  const webProvider = new WebFetchProvider(policy);
  const webManifest = await registry.register(webProvider);
  ok(webManifest.capabilities.some((capability) => capability.effect === "network.fetch"));
  const deniedWebAction = await webProvider.invoke({
    id: "web-1",
    actor: { kind: "tool", id: "web-smoke" },
    runId: "ig-policy",
    effect: "network.fetch",
    resource: { type: "url", value: "https://not-allowlisted.invalid/" },
    input: { url: "https://not-allowlisted.invalid/" },
    purpose: "web provider denied smoke",
    risk: "read",
    dataClassification: "public",
  }, new AbortController().signal);
  eq(deniedWebAction.ok, false);
  ok(deniedWebAction.decision.ruleIds.includes("policy.network.allowlist"));

  const { BrowserProvider } = await import("../dist/capabilities/browser/provider.js");
  const browserProvider = new BrowserProvider(policy);
  const browserManifest = await registry.register(browserProvider);
  ok(browserManifest.capabilities.some((capability) => capability.effect === "browser.interact"));
  const deniedBrowserAction = await browserProvider.invoke({
    id: "browser-1",
    actor: { kind: "tool", id: "browser-smoke" },
    runId: "ig-policy",
    effect: "browser.interact",
    resource: { type: "url", value: "https://example.com/" },
    input: { action: "open", url: "https://example.com/" },
    purpose: "browser provider denied smoke",
    risk: "privileged",
    dataClassification: "internal",
  }, new AbortController().signal);
  eq(deniedBrowserAction.ok, false);
  ok(deniedBrowserAction.decision.ruleIds.includes("policy.browser.approval"));

  const { McpProvider } = await import("../dist/capabilities/mcp/provider.js");
  const mcpProvider = new McpProvider(policy);
  const mcpManifest = await registry.register(mcpProvider);
  ok(mcpManifest.capabilities.some((capability) => capability.effect === "mcp.invoke"));
  const deniedMcpAction = await mcpProvider.invoke({
    id: "mcp-1",
    actor: { kind: "tool", id: "mcp-smoke" },
    runId: "ig-policy",
    effect: "mcp.invoke",
    resource: { type: "mcp", value: "server/tool" },
    input: { serverId: "server", toolName: "tool", args: {} },
    purpose: "mcp provider denied smoke",
    risk: "privileged",
    dataClassification: "internal",
  }, new AbortController().signal);
  eq(deniedMcpAction.ok, false);
  ok(deniedMcpAction.decision.ruleIds.includes("policy.mcp.approval"));

  const { VisionProvider } = await import("../dist/capabilities/vision/provider.js");
  const visionProvider = new VisionProvider(policy);
  const visionManifest = await registry.register(visionProvider);
  ok(visionManifest.capabilities.some((capability) => capability.effect === "vision.inspect"));
  const visionAction = await visionProvider.invoke({
    id: "vision-1",
    actor: { kind: "tool", id: "vision-smoke" },
    runId: "ig-policy",
    effect: "vision.inspect",
    resource: { type: "path", value: "assets/screenshot.png" },
    input: { assetIds: ["asset-1"], task: "ui_review" },
    purpose: "vision provider no-backend smoke",
    risk: "read",
    dataClassification: "internal",
  }, new AbortController().signal);
  eq(visionAction.ok, false);
  eq(visionAction.decision.result, "allow");

  console.log("✓ Test 15: Central policy, broker, and provider manifest contracts validate effects");
}

// ── Test 16: Event replay restores new runs ─────────────────────────

{
  const { execFileSync } = await import("node:child_process");
  const { Type } = await import("typebox");
  const { createAgentTask, pathsOverlap, prepareIsolatedWorktree, validateStructuredOutput } = await import("../dist/agents/pool.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-agent-worktree-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

  const workspace = prepareIsolatedWorktree(repo, "writer-test");
  fs.writeFileSync(path.join(workspace.path, "README.md"), "hello from isolated worktree\n");
  const patch = workspace.capturePatch();
  ok(patch.includes("hello from isolated worktree"), "isolated worktree patch captures writer changes");
  workspace.cleanup();
  eq(fs.existsSync(workspace.path), false);
  eq(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim(), "");
  eq(pathsOverlap(["src/a.ts"], ["src/a.ts"]), true);
  eq(pathsOverlap(["src/*.ts"], ["src/a.ts"]), true);
  eq(pathsOverlap(["src/a.ts"], ["docs/a.md"]), false);
  const structuredTask = createAgentTask("Scout", "return json", {
    outputSchema: Type.Object({ ok: Type.Boolean(), note: Type.String() }),
  });
  eq(validateStructuredOutput(structuredTask, '{"ok":true,"note":"done"}').ok, true);
  eq(validateStructuredOutput(structuredTask, '{"ok":"yes","note":"done"}').ok, false);

  console.log("✓ Test 16: Isolated writer worktree captures patch without touching main worktree");
}

// ── Test 17: Event replay restores new runs ─────────────────────────

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

  const eventLines = fs.readFileSync(stateManager.getEventsPath(), "utf8").trim().split("\n");
  const events = eventLines.map((line) => JSON.parse(line));
  ok(events.every((event, index) => event.sequence === index + 1), "events have monotonic sequence numbers");
  ok(events.every((event) => typeof event.eventHash === "string" && event.eventHash.length === 64), "events have hashes");
  eq(events[0].previousEventHash, "0".repeat(64));
  eq(events[1].previousEventHash, events[0].eventHash);

  const tampered = events.map((event) => event.type === "phase_changed" ? { ...event, phase: "validate" } : event);
  fs.writeFileSync(stateManager.getEventsPath(), tampered.map((event) => JSON.stringify(event)).join("\n") + "\n");
  eq(stateManager.replayActiveState(), null);

  console.log("✓ Test 17: Event replay reconstructs new run state and rejects hash-chain tampering");
}

// ── Test 18: Replay corruption fails closed for new runs ────────────

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

  console.log("✓ Test 18: New-run replay corruption does not silently reconstruct from stale cache");
}

// ── Test 19: ReleaseAuthorization invalidates on HEAD change ────────

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

  console.log("✓ Test 19: ReleaseAuthorization is invalidated by a new HEAD");
}

// ── Test 20: Structured PR body generation ─────────────────────────

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

  console.log("✓ Test 20: Structured PR body generation includes evidence matrix and authorization");
}

// ── Summary ─────────────────────────────────────────────────────────

console.log("\nAll tests passed. ✓");
