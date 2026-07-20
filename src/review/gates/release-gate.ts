import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { StateManagerAPI } from "../../state.js";
import type { IterativeGoalState } from "../../types.js";
import {
  loadTrustedVerificationConfig,
  readTrustedVerificationReceipt,
  trustedVerificationPolicyMatches,
} from "../../trusted-verification.js";

export interface LocalReleaseGateVerdict {
  ok: boolean;
  reasons: string[];
}

export async function runLocalReleaseGate(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
  cwd = state.projectInstructions.repoRoot ?? state.projectInstructions.cwd ?? process.cwd(),
): Promise<LocalReleaseGateVerdict> {
  const reasons: string[] = [];

  try {
    const trustedConfig = loadTrustedVerificationConfig(cwd);
    if (state.trustedVerification?.required && !trustedVerificationPolicyMatches(state.trustedVerification, trustedConfig)) {
      reasons.push("pinned trusted-verification policy was disabled or changed after goal start");
    } else if (trustedConfig.enabled || state.trustedVerification?.required) {
      const receipt = readTrustedVerificationReceipt(cwd, state, stateManager);
      if (!receipt?.ok) reasons.push("missing or invalid kernel-owned trusted-verification receipt for current HEAD");
    }
  } catch (error) {
    reasons.push(`trusted-verification configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    // The receipt is bound to tracked delivered HEAD. Pre-existing untracked
    // operator files are outside that commit and must neither block release
    // nor be swept into it; tracked modifications still fail closed.
    const status = execSync("git status --porcelain --untracked-files=no", { cwd, encoding: "utf-8", timeout: 10_000 }).trim();
    if (status) reasons.push("working tree has uncommitted tracked changes");
  } catch {
    reasons.push("could not read git status");
  }

  const implementVerifyPath = stateManager.getArtifactPath(state.cycle, "implement", "implementation-verification.json");
  if (!fs.existsSync(implementVerifyPath)) {
    reasons.push("missing implementation-verification.json evidence");
  } else {
    try {
      const verification = JSON.parse(fs.readFileSync(implementVerifyPath, "utf-8"));
      if (verification.allowlistViolation || (verification.extraFiles ?? []).length > 0) {
        reasons.push("implementation changed files outside approved plan scope");
      }
    } catch {
      reasons.push("implementation-verification.json is not parseable");
    }
  }

  const validationResultsPath = stateManager.getArtifactPath(state.cycle, "validate", "verification-results.jsonl");
  if (!fs.existsSync(validationResultsPath)) {
    reasons.push("missing verification-results.jsonl evidence");
  } else {
    const lines = fs.readFileSync(validationResultsPath, "utf-8").split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) reasons.push("verification-results.jsonl has no checks");
    for (const line of lines) {
      try {
        const result = JSON.parse(line);
        if (result.status !== "PASS") {
          reasons.push(`verification check did not pass: ${result.id ?? result.name ?? "unknown"}=${result.status}`);
        }
      } catch {
        reasons.push("verification-results.jsonl contains an invalid JSON line");
      }
    }
  }

  if (!state.artifacts.validations.some((artifact) => artifact.cycle === state.cycle && artifact.status === "completed")) {
    reasons.push("current cycle has no completed validation artifact");
  }

  return { ok: reasons.length === 0, reasons };
}
