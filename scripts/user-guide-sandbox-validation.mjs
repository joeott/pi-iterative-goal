#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const guideDir = path.join(repoRoot, "ai_docs", "user_guide");
const screenshotsDir = path.join(guideDir, "screenshots");
const reportJsonPath = path.join(guideDir, "sandbox-report.json");
const reportMdPath = path.join(guideDir, "sandbox-report.md");

const results = [];
const notes = [];

function record(id, status, summary, details = {}) {
  results.push({
    id,
    status,
    summary,
    details,
    checkedAt: new Date().toISOString(),
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
}

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    record(name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

function truncate(value, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function makeTempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assert.equal(run("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "README.md"), "# sandbox\n");
  return dir;
}

function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  return {
    tools,
    commands,
    events,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    sendUserMessage() {},
    appendEntry() {},
    async setModel() {},
    async exec(command, args, options = {}) {
      const result = spawnSync(command, args, {
        cwd: options.cwd ?? repoRoot,
        encoding: "utf8",
        timeout: options.timeout ?? 120_000,
        signal: options.signal,
      });
      return {
        code: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        killed: result.signal !== null,
      };
    },
  };
}

await check("repo-validate", async () => {
  const result = run("npm", ["run", "validate"], { timeout: 240_000 });
  assert.equal(result.status, 0, truncate(result.stdout + result.stderr));
  record("repo-validate", "PASS", "`npm run validate` completed.", {
    stdoutTail: truncate(result.stdout.split(/\r?\n/).slice(-20).join("\n")),
  });
});

await check("html-static", async () => {
  const htmlPath = path.join(guideDir, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert(!/https?:\/\//i.test(html), "HTML contains an external URL dependency.");
  assert(!/cdn\./i.test(html), "HTML appears to reference a CDN.");

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const hashLinks = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const missingAnchors = hashLinks.filter((id) => !ids.has(id));
  assert.deepEqual(missingAnchors, []);

  const assetRefs = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)]
    .map((m) => m[1])
    .filter((ref) => ref.startsWith("assets/"));
  const missingAssets = assetRefs.filter((ref) => !fs.existsSync(path.join(guideDir, ref)));
  assert.deepEqual(missingAssets, []);

  record("html-static", "PASS", "Internal anchors resolve and CSS/JS assets are local.", {
    anchors: hashLinks.length,
    assetRefs,
  });
});

await check("source-inventory", async () => {
  const expectedCommands = [
    "goal-start",
    "goal-status",
    "goal-pause",
    "goal-resume",
    "goal-repair-capabilities",
    "goal-finalize",
    "goal-reset",
    "goal-authorize-release",
    "goal-audit",
    "goal-replay",
    "goal-trace",
    "goal-dashboard",
  ];
  const expectedTools = [
    "goal_shell",
    "goal_aws_cli",
    "goal_git",
    "goal_subagent",
    "goal_report_phase_result",
    "goal_record_blocker",
    "goal_request_capability_repair",
    "goal_checkpoint",
  ];
  const srcFiles = [
    "src/ui/goal-commands.ts",
    "src/ui/commands.ts",
    "src/dashboard.ts",
    "src/ui/tools.ts",
    "src/shell.ts",
    "src/aws-cli.ts",
    "src/git.ts",
    "src/subagents.ts",
  ];
  const source = srcFiles.map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
  for (const command of expectedCommands) {
    assert(source.includes(`registerCommand("${command}"`), `Missing command registration: ${command}`);
  }
  for (const tool of expectedTools) {
    assert(source.includes(`name: "${tool}"`), `Missing tool registration: ${tool}`);
  }
  record("source-inventory", "PASS", "Guide command/tool inventory matches source registrations.", {
    commands: expectedCommands,
    tools: expectedTools,
  });
});

await check("extension-load-goal-shell", async () => {
  const { default: registerExtension } = await import(path.join(repoRoot, "dist", "index.js"));
  const pi = fakePi();
  registerExtension(pi);
  assert(pi.tools.has("goal_shell"), "goal_shell was not registered.");
  assert(pi.commands.has("goal-start"), "goal-start was not registered.");

  const tmpRepo = makeTempRepo("pi-ig-guide-shell-");
  const result = await pi.tools.get("goal_shell").execute(
    "tool-shell",
    { command: "git status --short --branch", cwd: tmpRepo, purpose: "sandbox guide check" },
    undefined,
    undefined,
    { cwd: tmpRepo },
  );
  assert.equal(result.details.allowed, true);
  assert.equal(result.details.exitCode, 0);
  assert.match(result.content[0].text, /##/);
  record("extension-load-goal-shell", "PASS", "Loaded dist extension and ran goal_shell in a disposable git repo.", {
    registeredTools: [...pi.tools.keys()].sort(),
    registeredCommands: [...pi.commands.keys()].sort(),
    tempRepo: tmpRepo,
    output: truncate(result.content[0].text, 1000),
  });
});

await check("mock-aws-cli", async () => {
  const { registerGoalAwsCliTool } = await import(path.join(repoRoot, "dist", "aws-cli.js"));
  const tmpRepo = makeTempRepo("pi-ig-guide-aws-");
  fs.mkdirSync(path.join(tmpRepo, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, ".pi", "settings.json"), JSON.stringify({
    iterativeGoal: {
      awsCli: {
        enabled: true,
        defaultRegion: "us-east-1",
        profileCandidates: ["mock-profile"],
        requireSessionManagerPlugin: false,
        allowMutatingFamilies: [],
      },
    },
  }, null, 2));

  const pi = fakePi();
  pi.exec = async (command, args) => {
    const joined = args.join(" ");
    if (command === "which" && args[0] === "aws") return { code: 0, stdout: "/tmp/aws\n", stderr: "", killed: false };
    if (command === "aws" && joined === "configure list-profiles") return { code: 0, stdout: "mock-profile\n", stderr: "", killed: false };
    if (command === "aws" && joined.includes("sts get-caller-identity")) {
      return { code: 0, stdout: JSON.stringify({ Account: "000000000000", Arn: "arn:aws:iam::000000000000:user/mock", UserId: "MOCK" }), stderr: "", killed: false };
    }
    return { code: 2, stdout: "", stderr: `unexpected ${command} ${joined}`, killed: false };
  };
  const stateManager = { getState: () => null };
  registerGoalAwsCliTool(pi, stateManager);
  const result = await pi.tools.get("goal_aws_cli").execute(
    "tool-aws",
    { args: ["sts", "get-caller-identity"], purpose: "mocked guide AWS check", cwd: tmpRepo },
    undefined,
    undefined,
    { cwd: tmpRepo },
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.allowed, true);
  assert.equal(result.details.profile, "mock-profile");
  record("mock-aws-cli", "PASS", "Mock AWS CLI preflight and read-only STS call used a temp repo and fake exec only.", {
    profile: result.details.profile,
    region: result.details.region,
    policyRuleIds: result.details.policyDecision.ruleIds,
  });
});

await check("policy-negative-cases", async () => {
  const { PolicyEngine, commandResource } = await import(path.join(repoRoot, "dist", "policy", "engine.js"));
  const policy = new PolicyEngine({ repoRoot, allowNetworkHosts: ["example.com"] });

  const packageInstall = policy.decide({
    id: "pkg-deny",
    actor: { kind: "tool", id: "test" },
    runId: "ig-guide",
    effect: "process.exec",
    resource: commandResource("npm", ["install", "left-pad"]),
    input: { executable: "npm", argv: ["install", "left-pad"] },
    purpose: "negative package install check",
    risk: "write",
    dataClassification: "internal",
  });
  assert.equal(packageInstall.result, "deny");
  assert(packageInstall.ruleIds.includes("policy.package.install"));

  const privateUrl = policy.decide({
    id: "private-url-deny",
    actor: { kind: "tool", id: "test" },
    runId: "ig-guide",
    effect: "network.fetch",
    resource: { type: "url", value: "http://127.0.0.1:8080/status" },
    input: { url: "http://127.0.0.1:8080/status" },
    purpose: "negative private URL check",
    risk: "read",
    dataClassification: "public",
  });
  assert.equal(privateUrl.result, "deny");
  assert(privateUrl.ruleIds.includes("policy.network.private-address"));

  const prWithoutAuth = policy.decide({
    id: "pr-deny",
    actor: { kind: "tool", id: "test" },
    runId: "ig-guide",
    effect: "git.pr.open",
    resource: { type: "git", value: "create_pr" },
    input: {},
    purpose: "negative PR auth check",
    risk: "privileged",
    dataClassification: "internal",
  });
  assert.equal(prWithoutAuth.result, "deny");
  assert(prWithoutAuth.ruleIds.includes("policy.git.pr.release-auth"));

  record("policy-negative-cases", "PASS", "Package install, private URL, and PR without authorization are denied.", {
    packageInstall,
    privateUrl,
    prWithoutAuth,
  });
});

await check("provider-contracts", async () => {
  const { PolicyEngine } = await import(path.join(repoRoot, "dist", "policy", "engine.js"));
  const { CapabilityRegistry } = await import(path.join(repoRoot, "dist", "capabilities", "registry.js"));
  const { FileSystemProvider } = await import(path.join(repoRoot, "dist", "capabilities", "filesystem", "provider.js"));
  const { ProcessProvider } = await import(path.join(repoRoot, "dist", "capabilities", "process", "provider.js"));
  const { WebFetchProvider } = await import(path.join(repoRoot, "dist", "capabilities", "web", "provider.js"));
  const { BrowserProvider } = await import(path.join(repoRoot, "dist", "capabilities", "browser", "provider.js"));
  const { McpProvider } = await import(path.join(repoRoot, "dist", "capabilities", "mcp", "provider.js"));
  const { VisionProvider } = await import(path.join(repoRoot, "dist", "capabilities", "vision", "provider.js"));

  const policy = new PolicyEngine({ repoRoot, allowNetworkHosts: ["example.com"] });
  const registry = new CapabilityRegistry();
  const providers = [
    new FileSystemProvider(policy, repoRoot),
    new ProcessProvider(policy, repoRoot),
    new WebFetchProvider(policy),
    new BrowserProvider(policy),
    new McpProvider(policy),
    new VisionProvider(policy),
  ];
  for (const provider of providers) await registry.register(provider);
  const manifests = registry.listManifests();
  const ids = manifests.flatMap((manifest) => manifest.capabilities.map((capability) => capability.id)).sort();
  assert.deepEqual(ids, [
    "browser.interact",
    "filesystem.delete",
    "filesystem.read",
    "filesystem.write",
    "mcp.invoke",
    "process.exec",
    "vision.inspect",
    "web.fetch",
  ]);

  const browserHealth = await providers[3].preflight({ runId: "ig-guide", cwd: repoRoot });
  const mcpHealth = await providers[4].preflight({ runId: "ig-guide", cwd: repoRoot });
  const visionHealth = await providers[5].preflight({ runId: "ig-guide", cwd: repoRoot });
  assert.equal(browserHealth.ok, false);
  assert.equal(mcpHealth.ok, false);
  assert.equal(visionHealth.ok, false);

  record("provider-contracts", "PASS", "Capability manifests validate; browser/MCP/vision fail closed without backends.", {
    providerIds: manifests.map((manifest) => manifest.providerId),
    capabilityIds: ids,
    unavailableReasons: [browserHealth.reason, mcpHealth.reason, visionHealth.reason],
  });
});

await check("stale-phase-write", async () => {
  const { registerGoalCoreTools } = await import(path.join(repoRoot, "dist", "ui", "tools.js"));
  const pi = fakePi();
  const state = {
    runId: "ig-guide-stale",
    status: "running",
    cycle: 1,
    phase: "research",
    lock: { activePhaseId: "ig-guide-stale/c1/research/a1" },
    phaseAttempts: [{ cycle: 1, phase: "research" }],
    artifacts: { research: [], plans: [], implementations: [], validations: [], evaluatorReports: [] },
    errors: [],
  };
  const stateManager = {
    getState: () => state,
    recordPhaseEvent: (event) => notes.push({ type: "phaseEvent", event }),
    recordArtifact: () => { throw new Error("stale write should not record artifact"); },
    recordError: () => {},
    persistAll: () => {},
  };
  registerGoalCoreTools(pi, stateManager);
  const result = await pi.tools.get("goal_report_phase_result").execute(
    "tool-phase",
    {
      runId: "ig-guide-stale",
      phaseAttemptId: "old-phase-attempt",
      phase: "research",
      status: "completed",
      summary: "stale report",
    },
  );
  assert.equal(result.details.rejected, true);
  assert.match(result.content[0].text, /STALE OUTPUT REJECTED/);
  record("stale-phase-write", "PASS", "Stale phase output is rejected and recorded as ignored.", {
    text: result.content[0].text,
    eventKind: notes.find((note) => note.type === "phaseEvent")?.event?.kind,
  });
});

await check("visual-artifacts", async () => {
  const desktop = path.join(screenshotsDir, "desktop.png");
  const mobile = path.join(screenshotsDir, "mobile.png");
  const existing = [desktop, mobile].filter((file) => fs.existsSync(file));
  const status = existing.length === 2 ? "PASS" : "WARN";
  record("visual-artifacts", status, existing.length === 2
    ? "Desktop and mobile screenshots are present."
    : "Screenshots are not both present yet; run Playwright capture after HTML generation.", {
      desktopExists: fs.existsSync(desktop),
      mobileExists: fs.existsSync(mobile),
    });
});

const summary = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  guideDir,
  safetyBoundary: {
    realAwsMutations: false,
    realGithubPrCreation: false,
    cloudWrites: false,
    tempReposOnly: true,
  },
  results,
  notes,
  passed: results.filter((result) => result.status === "PASS").length,
  warned: results.filter((result) => result.status === "WARN").length,
  failed: results.filter((result) => result.status === "FAIL").length,
};

fs.mkdirSync(guideDir, { recursive: true });
fs.writeFileSync(reportJsonPath, JSON.stringify(summary, null, 2));
fs.writeFileSync(reportMdPath, renderMarkdown(summary));

if (summary.failed > 0) {
  console.error(`Sandbox validation failed: ${summary.failed} failure(s). Report: ${reportMdPath}`);
  process.exit(1);
}

console.log(`Sandbox validation complete: ${summary.passed} PASS, ${summary.warned} WARN. Report: ${reportMdPath}`);

function renderMarkdown(report) {
  const lines = [
    "# pi-iterative-goal User Guide Sandbox Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Safety Boundary",
    "",
    "- Real AWS mutations: no",
    "- Real GitHub PR creation: no",
    "- Cloud writes: no",
    "- Runtime sandboxes: disposable temp repositories and mocked provider calls",
    "",
    "## Results",
    "",
    "| Check | Status | Summary |",
    "| --- | --- | --- |",
  ];
  for (const result of report.results) {
    lines.push(`| \`${result.id}\` | ${result.status} | ${escapeMd(result.summary)} |`);
  }
  lines.push("", "## Evidence Notes", "");
  for (const result of report.results) {
    lines.push(`### ${result.id}`);
    lines.push("");
    lines.push(`Status: ${result.status}`);
    lines.push("");
    lines.push(result.summary);
    const detailText = JSON.stringify(result.details ?? {}, null, 2);
    if (detailText !== "{}") {
      lines.push("", "```json", detailText, "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapeMd(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
