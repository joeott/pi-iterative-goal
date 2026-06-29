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
const modelContext = processModelVisibleHandoff(handoffText, handoffPath);
const commands = extractSafeCommands(handoffText);
if (commands.length === 0) {
  throw new Error(`No safe read-only validation commands found in ${handoffPath}`);
}
const previousSummary = loadPreviousSummary();

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
  modelVisibleContext: {
    path: path.join(runDir, "handoff-model-context.md"),
    sourceSha256: handoffSha256,
    dlp: modelContext.dlp,
    ipiDetected: modelContext.ipiDetected,
    wrapped: true,
  },
  safeCommands: commands.length,
  retiredIdentifierPolicy: "Retired OCR/SQS/Step Functions identifiers are treated only as resurrection risks unless read-only evidence shows they are active.",
  prioritizedLanes: [
    "Aurora encryption/deletion protection",
    "Pipeline Controller IAM and S3 supply chain",
    "Adapter ingress/egress and OCR invocation authorization",
    "CAS/evidence overwrite/delete hardening",
    "Graph projection controls",
    "Cross-account secrets trust",
    "CI/deploy scanner and agent trace redaction",
  ],
  iterations: [],
  findingSummary: null,
  findingChanges: null,
  drift: null,
};
fs.writeFileSync(summary.modelVisibleContext.path, modelContext.wrapped);

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
finalizeReviewState();
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
  report.findings = dryRun ? [] : analyzeIteration(report);
  report.findingCounts = countFindings(report.findings);
  report.awsStateFingerprint = dryRun ? null : fingerprintIteration(report);
  fs.writeFileSync(path.join(runDir, `iteration-${String(index).padStart(3, "0")}.json`), JSON.stringify(report, null, 2));
  return report;
}

function writeArtifacts() {
  const summaryPath = path.join(runDir, "review-summary.json");
  const mdPath = path.join(runDir, "review-summary.md");
  const latestFindings = latestIteration()?.findings ?? [];
  const findingsJsonPath = path.join(runDir, "findings.json");
  const findingsJsonlPath = path.join(runDir, "findings.jsonl");
  fs.writeFileSync(findingsJsonPath, JSON.stringify(latestFindings, null, 2));
  fs.writeFileSync(findingsJsonlPath, latestFindings.map((finding) => JSON.stringify(finding)).join("\n") + (latestFindings.length ? "\n" : ""));
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(summary));
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.copyFileSync(summaryPath, path.join(outputRoot, "latest-readonly-review.json"));
  fs.copyFileSync(mdPath, path.join(outputRoot, "latest-readonly-review.md"));
  fs.copyFileSync(findingsJsonPath, path.join(outputRoot, "latest-findings.json"));
  fs.copyFileSync(findingsJsonlPath, path.join(outputRoot, "latest-findings.jsonl"));
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
    `- Model-visible handoff context: \`${report.modelVisibleContext.path}\``,
    `- Findings: \`${report.findingSummary?.open ?? 0}\` open, \`${report.findingSummary?.new ?? 0}\` new, \`${report.findingSummary?.repeated ?? 0}\` repeated`,
    `- Drift detected: \`${report.drift?.changed ?? false}\``,
    `- Iterations: \`${report.iterations.length}\``,
    "",
    "| Iteration | PASS | FAIL | BLOCKED |",
    "|---:|---:|---:|---:|",
  ];
  for (const iteration of report.iterations) {
    lines.push(`| ${iteration.index} | ${count(iteration, "PASS")} | ${count(iteration, "FAIL")} | ${count(iteration, "BLOCKED")} |`);
  }
  const latest = report.iterations.at(-1);
  if (latest?.findings?.length) {
    lines.push("", "## Findings", "");
    for (const finding of latest.findings) {
      lines.push(`- \`${finding.id}\` ${finding.severity} ${finding.lifecycle}: ${finding.title}`);
    }
  }
  if (report.findingChanges?.resolved?.length) {
    lines.push("", "## Resolved Since Previous Run", "");
    for (const finding of report.findingChanges.resolved) {
      lines.push(`- \`${finding.id}\` ${finding.title}`);
    }
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

function latestIteration() {
  return summary.iterations.at(-1) ?? null;
}

function finalizeReviewState() {
  const latest = latestIteration();
  const findings = latest?.findings ?? [];
  const previousFindings = previousSummary?.iterations?.at(-1)?.findings ?? [];
  const previousById = new Map(previousFindings.map((finding) => [finding.id, finding]));
  for (const finding of findings) {
    finding.lifecycle = previousById.has(finding.id) ? "repeated" : "new";
  }
  const currentIds = new Set(findings.map((finding) => finding.id));
  const resolved = previousFindings
    .filter((finding) => !currentIds.has(finding.id))
    .map((finding) => ({ ...finding, lifecycle: "resolved" }));
  summary.findingSummary = {
    open: findings.length,
    new: findings.filter((finding) => finding.lifecycle === "new").length,
    repeated: findings.filter((finding) => finding.lifecycle === "repeated").length,
    resolved: resolved.length,
    bySeverity: countFindings(findings),
  };
  summary.findingChanges = {
    new: findings.filter((finding) => finding.lifecycle === "new"),
    repeated: findings.filter((finding) => finding.lifecycle === "repeated"),
    resolved,
  };
  const previousFingerprint = previousSummary?.iterations?.at(-1)?.awsStateFingerprint ?? null;
  summary.drift = {
    previousFingerprint,
    currentFingerprint: latest?.awsStateFingerprint ?? null,
    changed: Boolean(previousFingerprint && latest?.awsStateFingerprint && previousFingerprint !== latest.awsStateFingerprint),
  };
}

function count(iteration, status) {
  return iteration.commands.filter((command) => command.status === status).length;
}

function countFindings(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  return counts;
}

function analyzeIteration(iteration) {
  const artifacts = loadCommandArtifacts(iteration);
  const findings = [];
  const rdsCluster = artifacts.find((item) => item.service === "rds" && item.operation === "describe-db-clusters")?.json?.DBClusters?.[0];
  if (rdsCluster && (rdsCluster.StorageEncrypted === false || rdsCluster.DeletionProtection === false)) {
    const gaps = [
      rdsCluster.StorageEncrypted === false ? "StorageEncrypted=false" : null,
      rdsCluster.DeletionProtection === false ? "DeletionProtection=false" : null,
    ].filter(Boolean);
    findings.push(secFinding({
      id: "SEC-001",
      title: "Aurora production cluster lacks encryption or deletion protection",
      severity: rdsCluster.StorageEncrypted === false ? "critical" : "high",
      affected_repo: "unify",
      affected_resource: rdsCluster.DBClusterArn ?? rdsCluster.DBClusterIdentifier,
      production_status: "live",
      attack_lane: "RDS-1",
      attack_path: "An AWS principal with RDS or snapshot access can expose unencrypted data or accidentally delete/replace the cluster.",
      evidence: `${gaps.join(", ")} from rds describe-db-clusters for ${rdsCluster.DBClusterIdentifier}.`,
      impact: "High-severity confidentiality and availability risk for multi-tenant legal data.",
      reproduction_steps_read_only: ["aws rds describe-db-clusters --db-cluster-identifier ott-conformance-aurora --profile unify-old --region us-east-1"],
      fix: "Plan encrypted-cluster migration via snapshot restore/cutover and enable deletion protection on the production cluster.",
      regression_gate: "Read-only gate fails unless StorageEncrypted=true and DeletionProtection=true for ott-conformance-aurora.",
      owner: "unify platform",
    }));
  }

  const snapshots = artifacts.find((item) => item.service === "rds" && item.operation === "describe-db-cluster-snapshots")?.json?.DBClusterSnapshots ?? [];
  if (snapshots.some((snapshot) => snapshot.StorageEncrypted === false)) {
    findings.push(secFinding({
      id: "SEC-002",
      title: "Aurora automated snapshots are unencrypted",
      severity: "high",
      affected_repo: "unify",
      affected_resource: "ott-conformance-aurora snapshots",
      production_status: "live",
      attack_lane: "RDS-1",
      attack_path: "Snapshot copy/share/read paths can expose unencrypted legal database backups.",
      evidence: "At least one rds describe-db-cluster-snapshots result has StorageEncrypted=false.",
      impact: "Backup confidentiality risk persists even if the running instance is not public.",
      reproduction_steps_read_only: ["aws rds describe-db-cluster-snapshots --db-cluster-identifier ott-conformance-aurora --profile unify-old --region us-east-1"],
      fix: "Migrate backups to encrypted snapshots and require encrypted automated backup posture after cluster cutover.",
      regression_gate: "Read-only snapshot gate fails if any latest automated snapshot for ott-conformance-aurora has StorageEncrypted=false.",
      owner: "unify platform",
    }));
  }

  const pcPolicy = artifacts.find((item) => item.service === "iam" && item.operation === "get-role-policy" && /PipelineController/.test(item.command))?.json?.PolicyDocument;
  if (pcPolicy) {
    const statements = Array.isArray(pcPolicy.Statement) ? pcPolicy.Statement : [pcPolicy.Statement];
    const hasS3DeleteEvidence = statements.some((statement) => actions(statement).includes("s3:DeleteObject") && JSON.stringify(statement.Resource ?? "").includes("ott-legal-evidence-documents"));
    const hasBroadEcs = statements.some((statement) => actions(statement).some((action) => ["ecs:RunTask", "ecs:UpdateService"].includes(action)) && JSON.stringify(statement.Resource) === "\"*\"");
    const hasBroadPassRole = statements.some((statement) => actions(statement).includes("iam:PassRole") && JSON.stringify(statement.Resource ?? "").includes(":role/*"));
    if (hasS3DeleteEvidence || hasBroadEcs || hasBroadPassRole) {
      findings.push(secFinding({
        id: "SEC-003",
        title: "Pipeline Controller role can delete evidence or launch broad compute",
        severity: "critical",
        affected_repo: "unify",
        affected_resource: "UnifyOcrCpuStack-PipelineControllerPipelineControll-eTBCkPXF2Rhe",
        production_status: "live",
        attack_lane: "PC-1",
        attack_path: "Compromise of the Pipeline Controller instance/code path can use the role to mutate S3 evidence, launch/update ECS tasks, or pass broad roles.",
        evidence: [
          hasS3DeleteEvidence ? "s3:DeleteObject on ott-legal-evidence-documents/*" : null,
          hasBroadEcs ? "ecs:RunTask/UpdateService on Resource=*" : null,
          hasBroadPassRole ? "iam:PassRole on arn:aws:iam::371292405073:role/*" : null,
        ].filter(Boolean).join("; "),
        impact: "Evidence tampering, graph poisoning, unauthorized compute, and lateral movement through task roles.",
        reproduction_steps_read_only: ["aws iam get-role-policy --role-name UnifyOcrCpuStack-PipelineControllerPipelineControll-eTBCkPXF2Rhe --policy-name PipelineControllerPipelineControllerRoleDefaultPolicyA0058FF1 --profile unify-old"],
        fix: "Scope PC IAM to exact task definitions, cluster ARNs, Lambda ARNs, pass-role ARNs, and S3 prefixes; deny deletes on CAS/evidence prefixes.",
        regression_gate: "IAM policy gate fails on s3:DeleteObject to evidence bucket, ECS Resource=*, or iam:PassRole role wildcard.",
        owner: "unify platform",
      }));
    }
  }

  const securityGroups = artifacts.find((item) => item.service === "ec2" && item.operation === "describe-security-groups")?.json?.SecurityGroups ?? [];
  const adapterSg = securityGroups.find((group) => group.GroupId === "sg-02f7afa7fefba100f");
  if (adapterSg) {
    const ingressBroadVpc = permissions(adapterSg.IpPermissions).some((perm) => perm.from === 8080 && perm.cidr?.includes("172.31.0.0/16"));
    const egressAll = permissions(adapterSg.IpPermissionsEgress).some((perm) => perm.cidr?.includes("0.0.0.0/0") || perm.protocol === "-1");
    if (ingressBroadVpc || egressAll) {
      findings.push(secFinding({
        id: "SEC-004",
        title: "OCR adapter security group allows broad invocation or egress",
        severity: "high",
        affected_repo: "unify",
        affected_resource: adapterSg.GroupId,
        production_status: "live",
        attack_lane: ingressBroadVpc ? "OCR-1" : "OCR-2",
        attack_path: "A compromised VPC workload can invoke adapter OCR, or a compromised adapter can egress beyond exact required upstreams.",
        evidence: [
          ingressBroadVpc ? "ingress tcp/8080 from 172.31.0.0/16" : null,
          egressAll ? "egress includes 0.0.0.0/0 or all protocols" : null,
        ].filter(Boolean).join("; "),
        impact: "Unauthorized OCR of legal evidence, cost abuse, or document exfiltration path.",
        reproduction_steps_read_only: ["aws ec2 describe-security-groups --group-ids sg-02f7afa7fefba100f --profile unify-old --region us-east-1"],
        fix: "Restrict ingress to Pipeline Controller/intended SGs and replace all-egress with exact endpoints/upstreams.",
        regression_gate: "Security group gate fails if adapter ingress accepts 172.31.0.0/16 or egress allows 0.0.0.0/0.",
        owner: "unify platform",
      }));
    }
  }

  const lifecycleRules = artifacts.find((item) => item.service === "s3api" && item.operation === "get-bucket-lifecycle-configuration")?.json?.Rules ?? [];
  if (lifecycleRules.some((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays !== undefined && rule.NoncurrentVersionExpiration.NoncurrentDays < 30)) {
    findings.push(secFinding({
      id: "SEC-005",
      title: "Evidence bucket noncurrent version retention is too short for tamper recovery",
      severity: "medium",
      affected_repo: "unify",
      affected_resource: "s3://ott-legal-evidence-documents",
      production_status: "live",
      attack_lane: "S3-1",
      attack_path: "A principal with object write/delete can overwrite or delete evidence, with rollback window constrained by short noncurrent retention.",
      evidence: "S3 lifecycle reports noncurrent version expiration below 30 days.",
      impact: "Evidence tampering or data loss may become unrecoverable quickly.",
      reproduction_steps_read_only: ["aws s3api get-bucket-lifecycle-configuration --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1"],
      fix: "Deny deletes/overwrites on CAS prefixes, add object lock/governance retention, and extend noncurrent retention.",
      regression_gate: "S3 lifecycle/policy gate fails if CAS/evidence prefixes lack delete/overwrite protection or retention is below policy.",
      owner: "unify platform",
    }));
  }

  const xacctRole = artifacts.find((item) => item.service === "iam" && item.operation === "get-role-policy" && /final-fact-secrets-reader/.test(item.command))?.json?.PolicyDocument;
  if (xacctRole) {
    const statements = Array.isArray(xacctRole.Statement) ? xacctRole.Statement : [xacctRole.Statement];
    const listStar = statements.some((statement) => actions(statement).includes("secretsmanager:ListSecrets") && JSON.stringify(statement.Resource) === "\"*\"");
    const getFinalFact = statements.some((statement) => actions(statement).includes("secretsmanager:GetSecretValue") && JSON.stringify(statement.Resource ?? "").includes("final-fact/*"));
    if (listStar || getFinalFact) {
      findings.push(secFinding({
        id: "SEC-006",
        title: "Cross-account Final Fact secrets role has broad secret discovery/read blast radius",
        severity: "high",
        affected_repo: "final_fact",
        affected_resource: "arn:aws:iam::138881449763:role/final-fact-secrets-reader",
        production_status: "live",
        attack_lane: "XACCT-1",
        attack_path: "Compromise of the trusted prod workbench role can assume the reader and enumerate/read final-fact secrets in the payments/control account.",
        evidence: [
          getFinalFact ? "GetSecretValue on final-fact/*" : null,
          listStar ? "ListSecrets on Resource=*" : null,
        ].filter(Boolean).join("; "),
        impact: "Provider, graph, or vector credentials can be exfiltrated across accounts.",
        reproduction_steps_read_only: ["aws iam get-role-policy --role-name final-fact-secrets-reader --policy-name final-fact-secrets-read --profile api-admin"],
        fix: "Add external ID or session tag conditions, narrow ListSecrets, split secrets by purpose, and alert on AssumeRole/GetSecretValue.",
        regression_gate: "Cross-account trust gate fails if ListSecrets remains Resource=* or trust lacks external-id/session-tag conditions.",
        owner: "final_fact platform",
      }));
    }
  }

  const cpuStack = artifacts.find((item) => item.service === "cloudformation" && item.operation === "describe-stacks" && /UnifyOcrCpuStack/.test(item.command))?.json?.Stacks?.[0];
  if (cpuStack && Date.parse(cpuStack.LastUpdatedTime) < Date.parse("2026-06-29T10:55:00Z")) {
    findings.push(secFinding({
      id: "SEC-007",
      title: "Pipeline Controller stack update predates current hardening merge",
      severity: "medium",
      affected_repo: "unify",
      affected_resource: cpuStack.StackName,
      production_status: "source_merged_not_deployed",
      attack_lane: "PC-3",
      attack_path: "Operators may assume source-merged hardening is live before stack update or instance replacement proof exists.",
      evidence: `Stack LastUpdatedTime=${cpuStack.LastUpdatedTime}.`,
      impact: "Graph projection defaults, memory limits, or CAS-only source gates may be assumed live without proof.",
      reproduction_steps_read_only: ["aws cloudformation describe-stacks --stack-name UnifyOcrCpuStack --profile unify-old --region us-east-1"],
      fix: "Require deploy evidence: stack update after hardening merge plus instance/user-data/runtime flag proof.",
      regression_gate: "Deploy evidence gate fails unless stack timestamp and runtime proof postdate the hardening commit.",
      owner: "unify platform",
    }));
  }

  return findings;
}

function loadCommandArtifacts(iteration) {
  return iteration.commands.map((command) => {
    let text = "";
    let json = null;
    if (command.stdoutPath && fs.existsSync(command.stdoutPath)) {
      text = fs.readFileSync(command.stdoutPath, "utf8");
      try {
        json = text.trim() ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    }
    return { ...command, text, json };
  });
}

function secFinding(fields) {
  return {
    id: fields.id,
    title: fields.title,
    severity: fields.severity,
    affected_repo: fields.affected_repo,
    affected_resource: fields.affected_resource,
    production_status: fields.production_status,
    attack_lane: fields.attack_lane,
    attack_path: fields.attack_path,
    evidence: fields.evidence,
    impact: fields.impact,
    reproduction_steps_read_only: fields.reproduction_steps_read_only,
    fix: fields.fix,
    regression_gate: fields.regression_gate,
    owner: fields.owner,
    requires_production_access: false,
    requires_operator_approval: false,
    lifecycle: "unclassified",
  };
}

function actions(statement) {
  if (!statement?.Action) return [];
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function permissions(perms) {
  return (perms ?? []).flatMap((perm) => {
    const cidrs = [
      ...(perm.IpRanges ?? []).map((item) => item.CidrIp),
      ...(perm.Ipv6Ranges ?? []).map((item) => item.CidrIpv6),
    ].filter(Boolean);
    if (cidrs.length === 0) return [{ protocol: perm.IpProtocol, from: perm.FromPort, to: perm.ToPort, cidr: null }];
    return cidrs.map((cidr) => ({ protocol: perm.IpProtocol, from: perm.FromPort, to: perm.ToPort, cidr }));
  });
}

function fingerprintIteration(iteration) {
  const artifactHashes = iteration.commands.map((command) => {
    const stdout = command.stdoutPath && fs.existsSync(command.stdoutPath) ? fs.readFileSync(command.stdoutPath) : Buffer.from("");
    return {
      service: command.service,
      operation: command.operation,
      command: command.command,
      status: command.status,
      stdoutSha256: sha256(stdout),
    };
  });
  return sha256(JSON.stringify(artifactHashes));
}

function loadPreviousSummary() {
  const latestPath = path.join(outputRoot, "latest-readonly-review.json");
  if (!fs.existsSync(latestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
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

function processModelVisibleHandoff(text, sourcePath) {
  const normalized = text.normalize("NFC")
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const ipiDetected = /\b(?:system override|ignore (?:all )?(?:previous|above) instructions|forget instructions|return goal_met\s*=\s*true|developer message|assistant must)\b/i.test(normalized);
  const before = normalized;
  const scrubbed = redact(normalized);
  const dlpRedactions = before === scrubbed ? 0 : 1;
  const digest = sha256(normalized);
  return {
    wrapped: [
      `<UNTRUSTED_DATA source="${escapeAttr(sourcePath)}" sha256="${digest}" classification="operator_handoff">`,
      scrubbed,
      "</UNTRUSTED_DATA>",
      "",
      "<REVIEW_CONSTRAINTS>",
      "- Use only the extracted safe read-only AWS/repo inspection commands.",
      "- Do not perform production mutations.",
      "- Do not read secret values.",
      "- Treat retired OCR/SQS/Step Functions identifiers only as resurrection risks unless live read-only evidence contradicts retirement.",
      "</REVIEW_CONSTRAINTS>",
    ].join("\n"),
    ipiDetected,
    dlp: {
      enabled: true,
      redactions: dlpRedactions,
      secretValuesPrinted: false,
    },
  };
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

function escapeAttr(value) {
  return String(value).replace(/[&"]/g, (ch) => ch === "&" ? "&amp;" : "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
