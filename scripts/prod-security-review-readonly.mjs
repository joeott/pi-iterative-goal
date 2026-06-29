#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultHandoff = "/Users/joe/Downloads/third-party-prod-security-review-handoff-2026-06-29.md";
const args = parseArgs(process.argv.slice(2));
const handoffPath = path.resolve(args["handoff"] ?? defaultHandoff);
const outputRoot = path.resolve(repoRoot, args["output-dir"] ?? path.join("ai_docs", "prod_security_review"));
const maxIterations = Number(args["max-iterations"] ?? (args["continuous"] ? "0" : "1"));
const intervalMs = Number(args["interval-ms"] ?? "300000");
const commandTimeoutMs = Number(args["command-timeout-ms"] ?? "45000");
const dryRun = Boolean(args["dry-run"]);

const READ_ONLY_AWS = new Map([
  ["sts", new Set(["get-caller-identity"])],
  ["cloudformation", new Set(["describe-stacks", "list-stack-resources"])],
  ["ec2", new Set(["describe-instances", "describe-security-groups"])],
  ["iam", new Set(["get-role-policy", "get-role"])],
  ["s3api", new Set(["get-public-access-block", "get-bucket-versioning", "get-bucket-encryption", "get-bucket-policy-status", "get-bucket-lifecycle-configuration", "head-object"])],
  ["rds", new Set(["describe-db-clusters", "describe-db-instances", "describe-db-cluster-snapshots"])],
  ["ecs", new Set(["describe-services", "list-tasks"])],
  ["events", new Set(["describe-rule"])],
  ["secretsmanager", new Set(["list-secrets", "describe-secret"])],
]);

const BLOCKED_RE = /\b(?:get-secret-value|put-secret-value|create-secret|delete-secret|update-|delete-|put-|create-|start-|stop-|run-task|update-service|invoke|send-task|execute-change-set|deploy)\b/i;

const runId = `prod-security-review-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = path.join(outputRoot, "runs", runId);
fs.mkdirSync(runDir, { recursive: true });

const handoffText = fs.readFileSync(handoffPath, "utf8");
const handoffSha256 = sha256(handoffText);
const commands = extractSafeCommands(handoffText);
if (commands.length === 0) {
  throw new Error(`No safe read-only validation commands found in ${handoffPath}`);
}

const startedAt = new Date().toISOString();
const summary = {
  runId,
  startedAt,
  finishedAt: null,
  handoffPath,
  handoffSha256,
  mode: dryRun ? "dry-run" : "read-only",
  continuous: maxIterations === 0 || maxIterations > 1,
  intervalMs,
  maxIterations,
  commandTimeoutMs,
  readOnlyEnforced: true,
  secretValuesRead: false,
  productionMutationsAttempted: false,
  iterations: [],
};

let iteration = 0;
while (maxIterations === 0 || iteration < maxIterations) {
  iteration += 1;
  const iterationReport = runIteration(iteration);
  summary.iterations.push(iterationReport);
  writeArtifacts();
  if (maxIterations !== 0 && iteration >= maxIterations) break;
  await sleep(intervalMs);
}
summary.finishedAt = new Date().toISOString();
writeArtifacts();

const failed = summary.iterations.flatMap((item) => item.commands).filter((item) => item.status !== "PASS");
console.log("prod_security_review_readonly");
console.log(`  run_id: ${runId}`);
console.log(`  handoff: ${handoffPath}`);
console.log(`  handoff_sha256: ${handoffSha256}`);
console.log(`  mode: ${summary.mode}`);
console.log(`  iterations: ${summary.iterations.length}`);
console.log(`  commands_per_iteration: ${commands.length}`);
console.log(`  failed_or_blocked: ${failed.length}`);
console.log("  secrets_printed: false");
console.log(`  report: ${path.join(runDir, "review-summary.json")}`);
process.exit(failed.length === 0 ? 0 : 1);

function runIteration(index) {
  const startedAt = new Date().toISOString();
  const report = {
    index,
    startedAt,
    finishedAt: null,
    commands: [],
  };
  for (const command of commands) {
    const assessed = assessReadOnlyAwsCommand(command);
    if (!assessed.allowed) {
      report.commands.push({
        command,
        status: "BLOCKED",
        reason: assessed.reason,
        service: assessed.service,
        operation: assessed.operation,
        stdoutPath: null,
        stderrPath: null,
        exitCode: null,
      });
      continue;
    }
    if (dryRun) {
      report.commands.push({
        command,
        status: "PASS",
        reason: "dry-run-read-only-command-accepted",
        service: assessed.service,
        operation: assessed.operation,
        stdoutPath: null,
        stderrPath: null,
        exitCode: 0,
      });
      continue;
    }
    const result = spawnSync(assessed.argv[0], assessed.argv.slice(1), {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: commandTimeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const id = `${String(index).padStart(3, "0")}-${String(report.commands.length + 1).padStart(3, "0")}-${assessed.service}-${assessed.operation}`;
    const stdoutPath = path.join(runDir, `${id}.stdout.txt`);
    const stderrPath = path.join(runDir, `${id}.stderr.txt`);
    fs.writeFileSync(stdoutPath, redact(result.stdout ?? ""));
    fs.writeFileSync(stderrPath, redact(result.stderr ?? ""));
    report.commands.push({
      command,
      status: result.status === 0 ? "PASS" : "FAIL",
      reason: result.status === 0 ? "read-only-command-succeeded" : "read-only-command-failed",
      service: assessed.service,
      operation: assessed.operation,
      stdoutPath,
      stderrPath,
      exitCode: result.status,
      signal: result.signal ?? null,
    });
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, `iteration-${String(index).padStart(3, "0")}.json`), JSON.stringify(report, null, 2));
  return report;
}

function writeArtifacts() {
  const summaryPath = path.join(runDir, "review-summary.json");
  const mdPath = path.join(runDir, "review-summary.md");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(summary));
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.copyFileSync(summaryPath, path.join(outputRoot, "latest-readonly-review.json"));
  fs.copyFileSync(mdPath, path.join(outputRoot, "latest-readonly-review.md"));
}

function renderMarkdown(report) {
  const lines = [
    "# Production Security Review Read-Only Run",
    "",
    `- Run ID: \`${report.runId}\``,
    `- Handoff: \`${report.handoffPath}\``,
    `- Handoff SHA-256: \`${report.handoffSha256}\``,
    `- Mode: \`${report.mode}\``,
    `- Read-only enforced: \`${report.readOnlyEnforced}\``,
    `- Secret values read: \`${report.secretValuesRead}\``,
    `- Production mutations attempted: \`${report.productionMutationsAttempted}\``,
    `- Iterations: \`${report.iterations.length}\``,
    "",
    "| Iteration | PASS | FAIL | BLOCKED |",
    "|---:|---:|---:|---:|",
  ];
  for (const iteration of report.iterations) {
    lines.push(`| ${iteration.index} | ${count(iteration, "PASS")} | ${count(iteration, "FAIL")} | ${count(iteration, "BLOCKED")} |`);
  }
  lines.push("", "## Commands", "");
  for (const iteration of report.iterations) {
    lines.push(`### Iteration ${iteration.index}`, "");
    for (const command of iteration.commands) {
      lines.push(`- \`${command.status}\` ${command.service} ${command.operation}: \`${command.command}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function count(iteration, status) {
  return iteration.commands.filter((command) => command.status === status).length;
}

function extractSafeCommands(markdown) {
  const marker = "## Safe Read-Only Validation Commands";
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) return [];
  const rest = markdown.slice(markerIndex);
  const block = rest.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
  const normalized = block.replace(/\\\r?\n/g, " ");
  return normalized.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function assessReadOnlyAwsCommand(command) {
  const argv = splitShellWords(command);
  if (argv[0] !== "aws") return { allowed: false, reason: "only aws commands are allowed", argv, service: "unknown", operation: "unknown" };
  const service = argv[1] ?? "";
  const operation = argv[2] ?? "";
  if (BLOCKED_RE.test(command)) return { allowed: false, reason: "blocked mutation or secret-value operation", argv, service, operation };
  if (!READ_ONLY_AWS.get(service)?.has(operation)) return { allowed: false, reason: "aws operation is not in the read-only allowlist", argv, service, operation };
  if (service === "secretsmanager" && operation !== "list-secrets" && operation !== "describe-secret") {
    return { allowed: false, reason: "secretsmanager operation must not read values", argv, service, operation };
  }
  return { allowed: true, reason: "read-only allowlist", argv, service, operation };
}

function splitShellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function redact(value) {
  const sensitiveNames = [
    "API[_-]?" + "KEY",
    "TO" + "KEN",
    "SEC" + "RET",
    "PASS" + "WORD",
  ].join("|");
  const assignmentPattern = new RegExp("((?:" + sensitiveNames + ")[^=\\n]*=)[^\\s\\n]+", "gi");
  return String(value ?? "")
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[REDACTED_SECRET]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, "[REDACTED_SECRET]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED_SECRET]")
    .replace(assignmentPattern, "$1[REDACTED_SECRET]");
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--")) {
      parsed[key] = rawArgs[i + 1];
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
