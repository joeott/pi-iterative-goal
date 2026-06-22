import type { IterativeGoalState, PhaseArtifact } from "../types.js";
import * as fs from "node:fs";

export interface PullRequestBodyInput {
  state: IterativeGoalState;
  changedFiles: string[];
  diffStat: string;
  tests: Array<{
    id: string;
    status: string;
    exitCode?: number | null;
    artifactUri?: string | null;
  }>;
  auditRunId?: string;
}

export function generatePullRequestBody(input: PullRequestBodyInput): string {
  const { state } = input;
  const verdict = state.evaluator.lastVerdict;
  const release = state.releaseAuthorization;
  const latestPlan = state.artifacts.plans.at(-1);
  const latestImplementation = state.artifacts.implementations.at(-1);
  const latestValidation = state.artifacts.validations.at(-1);

  return [
    `# ${state.goal}`,
    "",
    "## Goal",
    "",
    `- Run ID: ${state.runId}`,
    `- Audit Run ID: ${input.auditRunId ?? state.runId}`,
    `- Completion criterion: ${state.goalCriterion}`,
    `- Cycle: ${state.cycle}`,
    "",
    "## Requirement To Evidence Matrix",
    "",
    "| Requirement | Evidence | Status |",
    "| --- | --- | --- |",
    `| Goal criterion | ${artifactLabel(latestValidation) || "validation artifact missing"} | ${latestValidation?.status ?? "missing"} |`,
    `| Plan scope | ${artifactLabel(latestPlan) || "plan artifact missing"} | ${latestPlan?.status ?? "missing"} |`,
    `| Implementation | ${artifactLabel(latestImplementation) || "implementation artifact missing"} | ${latestImplementation?.status ?? "missing"} |`,
    "",
    "## Changed Files",
    "",
    ...(input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`) : ["- None recorded"]),
    "",
    "## Diff Stat",
    "",
    "```text",
    input.diffStat || "No diff stat recorded.",
    "```",
    "",
    "## Tests And Gates",
    "",
    "| Check | Status | Exit Code | Evidence |",
    "| --- | --- | --- | --- |",
    ...(input.tests.length > 0
      ? input.tests.map((test) => `| ${test.id} | ${test.status} | ${test.exitCode ?? ""} | ${test.artifactUri ?? ""} |`)
      : ["| validation-results | NOT_RUN |  | Missing structured verification-results evidence |"]),
    "",
    "## Evaluator",
    "",
    verdict
      ? `- goal_met=${verdict.goal_met}; confidence=${verdict.confidence}; next_focus=${verdict.next_cycle_directive.focus}`
      : "- No evaluator verdict recorded.",
    ...(verdict?.completion_blockers?.length
      ? ["", "### Completion Blockers", "", ...verdict.completion_blockers.map((item) => `- ${item}`)]
      : []),
    "",
    "## Security And Policy",
    "",
    release
      ? [
          `- ReleaseAuthorization: ${release.id}`,
          `- Base SHA: ${release.baseSha}`,
          `- Head SHA: ${release.headSha}`,
          `- Plan hash: ${release.planHash}`,
          `- Requirements hash: ${release.requirementsHash}`,
          `- Gate verdict hash: ${release.gateVerdictHash}`,
          `- Evidence root hash: ${release.evidenceRootHash}`,
          `- Expires at: ${release.expiresAt}`,
        ].join("\n")
      : "- ReleaseAuthorization missing.",
    "",
    "## Remaining Risks And Waivers",
    "",
    "- See `ai_docs/autonomous_kernel_refactor_audit.md` for review finding dispositions and residual gaps.",
    "",
    "## Rollback",
    "",
    "- Revert this branch or the listed commits. The harness defaults to patch-only finalization unless git finalization is explicitly enabled.",
  ].join("\n");
}

export function readVerificationResults(resultsPath: string): PullRequestBodyInput["tests"] {
  if (!fs.existsSync(resultsPath)) return [];
  const tests: PullRequestBodyInput["tests"] = [];
  for (const line of fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const result = JSON.parse(line);
      tests.push({
        id: String(result.id ?? result.name ?? "unknown"),
        status: String(result.status ?? "UNKNOWN"),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        artifactUri: typeof result.artifact === "string" ? result.artifact : resultsPath,
      });
    } catch {
      tests.push({ id: "invalid-json-line", status: "FAIL", artifactUri: resultsPath });
    }
  }
  return tests;
}

function artifactLabel(artifact: PhaseArtifact | null | undefined): string {
  if (!artifact) return "";
  return `${artifact.phase} cycle ${artifact.cycle} at ${artifact.timestamp}`;
}
