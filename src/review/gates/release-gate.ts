import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { StateManagerAPI } from "../../state.js";
import type { IterativeGoalState } from "../../types.js";

export interface LocalReleaseGateVerdict {
  ok: boolean;
  reasons: string[];
}

export async function runLocalReleaseGate(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
): Promise<LocalReleaseGateVerdict> {
  const reasons: string[] = [];

  try {
    const status = execSync("git status --porcelain", { encoding: "utf-8", timeout: 10_000 }).trim();
    if (status) reasons.push("working tree has uncommitted or untracked changes");
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
