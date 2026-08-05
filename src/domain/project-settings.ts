/**
 * Shared .pi/settings.json reader for iterativeGoal.* feature configuration
 * (extracted in Campaign 2 remediation, C2-OUS-003).
 *
 * One guarded parse — try/catch plus null guards at every level — so a
 * malformed settings file degrades to defaults instead of wedging config
 * loading. Replaces the per-module copies in src/kernel/sharder.ts and
 * src/subagents.ts, which now both read through here.
 *
 * DEBT: src/git.ts and src/aws-cli.ts keep their own settings readers;
 * migrating them belongs to their owning campaigns, not the C2 sharder diff.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logDebug } from "../logging.js";

/** Returns the `iterativeGoal` subtree of .pi/settings.json ({} when absent/unparseable). */
export function readIterativeGoalSettings(cwd: string): Record<string, unknown> {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const iterativeGoal = (parsed as Record<string, unknown>).iterativeGoal;
    return iterativeGoal && typeof iterativeGoal === "object"
      ? iterativeGoal as Record<string, unknown>
      : {};
  } catch (err) {
    logDebug("project-settings", `Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
