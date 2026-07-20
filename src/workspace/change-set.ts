import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import type { StateManagerAPI } from "../state.js";
import type { IterativeGoalState } from "../types.js";
import {
  type PathScope,
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

// ── Per-shard patch verification (§6.6 merge gate part 1, Campaign 4) ──

/**
 * Changed-file extraction from a captured unified diff — GIT-NATIVE, never
 * regex-only (C4-ADV-001). git C-quotes paths containing non-ASCII, control,
 * quote, or backslash bytes in diff headers, so a regex on `diff --git`
 * silently drops exactly the sections an attacker would use, and the
 * allowlist then "passes" a patch it never inspected.
 *
 * The authoritative write-target list comes from `git apply --numstat -z`
 * (NUL-delimited, verbatim paths, no quoting; covers modifications,
 * additions, deletions, and rename post-images). Rename PRE-images are
 * unioned in from `rename from`/`rename to` headers with full C-style
 * unquoting. Every section must be accounted for: a section count mismatch,
 * a malformed numstat record, an unterminatable quoted path, or a git error
 * all fail CLOSED as an allowlist violation — a patch section is never
 * silently dropped.
 */

/** C-style unquoting for git path tokens ("…\303\244…" → raw UTF-8); null on any malformed escape. */
function unquoteGitCPath(token: string): string | null {
  if (!token.startsWith('"')) return token;
  const bytes: number[] = [];
  let i = 1;
  while (i < token.length) {
    const ch = token[i];
    if (ch === '"') return i === token.length - 1 ? Buffer.from(bytes).toString("utf8") : null;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      i += 1;
      continue;
    }
    i += 1;
    if (i >= token.length) return null;
    const esc = token[i];
    if (esc >= "0" && esc <= "7") {
      const oct = token.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    const simple: Record<string, number> = { "\\": 0x5c, '"': 0x22, a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
    if (!(esc in simple)) return null;
    bytes.push(simple[esc]);
    i += 1;
  }
  return null; // Unterminated quote.
}

export interface PatchChangedFiles {
  files: string[];
  /** Human-readable descriptions of sections that could not be parsed (non-empty ⇒ fail closed). */
  parseErrors: string[];
}

export function listPatchChangedFiles(patch: string, options: { cwd?: string } = {}): PatchChangedFiles {
  const files = new Set<string>();
  const parseErrors: string[] = [];
  const sectionCount = patch.split(/\r?\n/).filter((line) => line.startsWith("diff --git ")).length;
  let numstatRecords = 0;

  // Authoritative list: git's own patch parser, NUL-delimited output.
  // `git apply` requires the trailing newline the capture's .trim() removed.
  const payload = patch.endsWith("\n") ? patch : `${patch}\n`;
  try {
    const out = execFileSync("git", ["apply", "--numstat", "-z", "-"], {
      input: payload,
      cwd: options.cwd,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const record of out.toString("utf8").split("\0")) {
      if (!record) continue;
      numstatRecords += 1;
      // <added>\t<removed>\t<path> — split on the first two tabs only: the
      // path is verbatim (with -z git does not quote) and may itself
      // contain tabs.
      const firstTab = record.indexOf("\t");
      const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
      if (firstTab <= 0 || secondTab <= firstTab) {
        parseErrors.push(`malformed numstat record: ${JSON.stringify(record.slice(0, 120))}`);
        continue;
      }
      const path = record.slice(secondTab + 1);
      if (!path) {
        parseErrors.push(`numstat record with empty path: ${JSON.stringify(record.slice(0, 120))}`);
        continue;
      }
      files.add(path);
    }
  } catch (err) {
    const failure = err as { stderr?: Buffer; message?: string };
    const stderr = failure.stderr?.toString().trim();
    parseErrors.push(`git apply --numstat failed: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }

  // Rename pre-images: numstat lists only the post-image for a rename, so
  // union the `rename from` source (C-unquoted; fail closed on bad quoting).
  for (const line of patch.split(/\r?\n/)) {
    const rename = line.match(/^rename (from|to) (.+)$/);
    if (!rename) continue;
    const unquoted = unquoteGitCPath(rename[2]);
    if (unquoted === null) {
      parseErrors.push(`unparseable quoted path in header: ${JSON.stringify(line.slice(0, 160))}`);
      continue;
    }
    files.add(unquoted);
  }

  // Never silently drop a section: every `diff --git` section must have
  // produced exactly one numstat record.
  if (parseErrors.length === 0 && numstatRecords !== sectionCount) {
    parseErrors.push(`diff section count ${sectionCount} != numstat record count ${numstatRecords}`);
  }

  return { files: [...files].sort(), parseErrors };
}

export interface ShardPatchVerification {
  changedFiles: string[];
  extraFiles: string[];
  /** Sections the parser could not account for — always an allowlist violation (fail closed). */
  parseErrors: string[];
  allowlistViolation: boolean;
}

/**
 * Merge gate part 1 (§6.6): the shard's captured diff is checked against the
 * shard's OWN path-scope allowlist from the typed shard plan — not the
 * free-text plan allowlist verifyImplementationAgainstPlan uses for the
 * single-slice path. A patch touching anything outside the shard's exact-file
 * scope is an allowlist violation and the merge is rejected before any
 * application is attempted.
 *
 * Fail-closed twice over (C4-ADV-001/C4-ADV-002): sections that cannot be
 * parsed are violations, and a path the scope vocabulary cannot normalize
 * (e.g. containing spaces) is a violation too — never a thrown abort. The
 * sharder can never emit such a scope, so the file is out-of-scope by
 * construction; the merge layer routes it through the normal repair-loop
 * rejection.
 */
export function verifyShardPatchAgainstScope(
  patch: string,
  allowedPaths: PathScope[],
  options: { cwd?: string } = {},
): ShardPatchVerification {
  const { files, parseErrors } = listPatchChangedFiles(patch, options);
  const extraFiles: string[] = [];
  for (const file of files) {
    let inScope = false;
    try {
      inScope = pathInScopes(file, allowedPaths);
    } catch {
      // Un-normalizable path (spaces etc.): out-of-scope by construction.
      inScope = false;
    }
    if (!inScope) extraFiles.push(file);
  }
  return {
    changedFiles: files,
    extraFiles,
    parseErrors,
    allowlistViolation: extraFiles.length > 0 || parseErrors.length > 0,
  };
}
