import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { StateManagerAPI } from "../state.js";
import type { IterativeGoalState } from "../types.js";
import {
  extractPathScopesFromPlanText,
  pathInScopes,
  serializePathScope,
} from "../domain/path-scope.js";
import { extractAcceptedAmendmentScopes } from "../domain/plan.js";
import { logDebug } from "../logging.js";

function log(msg: string) {
  logDebug("change-set", msg);
}

export interface ImplementationVerification {
  changedFiles: string[];
  diffStat: string;
  allowlistViolation: boolean;
  plannedFiles: string[];
  extraFiles: string[];
}

export async function getChangedFiles(): Promise<string[]> {
  try {
    return execSync("git diff --name-only", { encoding: "utf-8", timeout: 10_000 })
      .trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function getDiffStat(): Promise<string> {
  try {
    return execSync("git diff --stat", { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return "unavailable";
  }
}

export async function verifyImplementationAgainstPlan(
  state: IterativeGoalState,
  stateManager: StateManagerAPI,
): Promise<ImplementationVerification> {
  let changedFiles: string[] = [];
  let diffStat = "";
  try {
    changedFiles = execSync("git diff --name-only", { encoding: "utf-8", timeout: 10_000 })
      .trim().split("\n").filter(Boolean);
    diffStat = execSync("git diff --stat", { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    log("git diff failed; implementation verification could not inspect the change set");
    return { changedFiles: [], diffStat: "", allowlistViolation: false, plannedFiles: [], extraFiles: [] };
  }

  const patchPath = stateManager.getArtifactPath(state.cycle, "implement", "diff.patch");
  try {
    fs.writeFileSync(patchPath, execSync("git diff", { encoding: "utf-8", timeout: 10_000 }));
  } catch {}

  const lastPlan = state.artifacts.plans.at(-1);
  const basePlanScopes = extractPathScopesFromPlanText(lastPlan?.content ?? "");
  const amendmentScopes = extractAcceptedAmendmentScopes(lastPlan?.content ?? "");
  const plannedScopes = [...basePlanScopes, ...amendmentScopes];
  const plannedFiles = plannedScopes.map(serializePathScope);
  const extraFiles = changedFiles.filter((file) => !pathInScopes(file, plannedScopes));

  const verifyPath = stateManager.getArtifactPath(state.cycle, "implement", "implementation-verification.json");
  try {
    fs.writeFileSync(verifyPath, JSON.stringify({
      runId: state.runId,
      cycle: state.cycle,
      phase: "implement",
      changedFiles,
      diffStat,
      plannedFiles,
      basePlanFiles: basePlanScopes.map(serializePathScope),
      acceptedAmendmentFiles: amendmentScopes.map(serializePathScope),
      extraFiles,
      allowlistViolation: extraFiles.length > 0,
      verifiedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}

  log(
    `Implementation verification: ${changedFiles.length} changed, ${plannedFiles.length} planned, ${extraFiles.length} extra, violation=${extraFiles.length > 0}`,
  );

  return {
    changedFiles,
    diffStat,
    allowlistViolation: extraFiles.length > 0,
    plannedFiles,
    extraFiles,
  };
}
