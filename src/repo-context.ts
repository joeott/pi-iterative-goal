import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { processModelVisibleText, attestAction } from "./cyber-runtime.js";
import { resolveContainedPath, normalizeRepoPath } from "./domain/path-scope.js";
import { PolicyEngine } from "./policy/engine.js";
import type { ActionRequest } from "./policy/engine.js";
import type { StateManagerAPI } from "./state.js";

export const RepoContextParams = Type.Object({
  mode: Type.Union([
    Type.Literal("read_file"),
    Type.Literal("search_text"),
    Type.Literal("list_files"),
  ]),
  path: Type.Optional(Type.String({ description: "Repository-relative file or directory path. Defaults to repository root." })),
  query: Type.Optional(Type.String({ description: "Search query for search_text mode." })),
  glob: Type.Optional(Type.String({ description: "Optional rg glob, for example src/**/*.ts." })),
  max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 100_000 })),
  max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  runId: Type.Optional(Type.String({ description: "Optional stale-run guard. If supplied, must match active run." })),
  phaseAttemptId: Type.Optional(Type.String({ description: "Optional stale-phase guard. If supplied, must match active phase attempt." })),
});

export type RepoContextParams = Static<typeof RepoContextParams>;

export interface RepoContextResultDetails {
  mode: RepoContextParams["mode"];
  repoRoot: string;
  path: string;
  query?: string;
  files: string[];
  bytes: number;
  truncated: boolean;
  dlpScanId: string | null;
  allowed: boolean;
  safetyCheckResult?: string;
}

function findRepoRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function relativePathForDisplay(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replace(/\\/g, "/") || ".";
}

function repoPath(paramsPath: string | undefined): string {
  if (!paramsPath || paramsPath.trim() === "." || paramsPath.trim() === "") return ".";
  return normalizeRepoPath(paramsPath);
}

function truncateText(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, bytes: bytes.length, truncated: false };
  return {
    text: bytes.subarray(0, maxBytes).toString("utf8"),
    bytes: maxBytes,
    truncated: true,
  };
}

function collectFiles(repoRoot: string, startPath: string, maxResults: number): string[] {
  const absoluteStart = startPath === "." ? fs.realpathSync(repoRoot) : resolveContainedPath(repoRoot, startPath);
  const files: string[] = [];
  const ignoredDirs = new Set([".git", "node_modules", "dist", ".pi"]);

  function walk(current: string): void {
    if (files.length >= maxResults) return;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      files.push(relativePathForDisplay(repoRoot, current));
      return;
    }
    if (!stat.isDirectory()) return;
    const base = path.basename(current);
    if (ignoredDirs.has(base)) return;
    for (const entry of fs.readdirSync(current).sort()) {
      walk(path.join(current, entry));
      if (files.length >= maxResults) return;
    }
  }

  walk(absoluteStart);
  return files;
}

function searchWithRg(repoRoot: string, params: RepoContextParams, maxResults: number, maxBytes: number): { text: string; files: string[]; truncated: boolean; bytes: number } {
  const query = params.query ?? "";
  const args = ["--line-number", "--no-heading", "--color", "never", "--fixed-strings", query];
  if (params.glob) args.push("--glob", params.glob);
  if (params.path && params.path.trim() && params.path.trim() !== ".") args.push(repoPath(params.path));
  const result = spawnSync("rg", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: maxBytes * 2,
  });
  const output = result.stdout || "";
  const lines = output.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
  const limited = truncateText(lines.join("\n"), maxBytes);
  return {
    text: limited.text,
    files: [...new Set(lines.map(line => line.split(":")[0]).filter(Boolean))],
    truncated: limited.truncated || output.split(/\r?\n/).filter(Boolean).length > lines.length,
    bytes: limited.bytes,
  };
}

function searchFallback(repoRoot: string, params: RepoContextParams, maxResults: number, maxBytes: number): { text: string; files: string[]; truncated: boolean; bytes: number } {
  const query = params.query ?? "";
  const files = collectFiles(repoRoot, repoPath(params.path), 5_000);
  const matches: string[] = [];
  const matchedFiles = new Set<string>();
  for (const file of files) {
    if (matches.length >= maxResults) break;
    if (params.glob && !globLikeMatch(file, params.glob)) continue;
    const absolute = resolveContainedPath(repoRoot, file);
    let content = "";
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (matches.length >= maxResults) return;
      if (line.includes(query)) {
        matches.push(`${file}:${idx + 1}:${line}`);
        matchedFiles.add(file);
      }
    });
  }
  const limited = truncateText(matches.join("\n"), maxBytes);
  return { text: limited.text, files: [...matchedFiles], truncated: limited.truncated || matches.length >= maxResults, bytes: limited.bytes };
}

function globLikeMatch(file: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(file);
}

function actionFor(params: {
  runId: string;
  mode: RepoContextParams["mode"];
  resource: string;
  input: unknown;
}): ActionRequest {
  return {
    id: `goal_repo_context:${crypto.randomBytes(6).toString("hex")}`,
    actor: { kind: "tool", id: "goal_repo_context" },
    runId: params.runId,
    effect: "fs.read",
    resource: { type: "path", value: params.resource },
    input: params.input,
    purpose: `repo context ${params.mode}`,
    risk: "read",
    dataClassification: "internal",
  };
}

export function registerGoalRepoContextTool(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
): void {
  pi.registerTool({
    name: "goal_repo_context",
    label: "Repo Context",
    description: "Read, list, or search repository files with path containment, DLP/IPI processing, and evidence attestation.",
    promptSnippet: "Inspect repository context without using raw shell",
    promptGuidelines: [
      "Use goal_repo_context for repo file reads, file listing, and text search before falling back to goal_shell. Include runId and phaseAttemptId when the phase prompt provides them.",
    ],
    parameters: RepoContextParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const state = stateManager.getState();
      if (state && params.runId && params.runId !== state.runId) {
        return rejected(`runId mismatch: got ${params.runId}, expected ${state.runId}`, ctx.cwd);
      }
      if (state && params.phaseAttemptId && state.lock.activePhaseId && params.phaseAttemptId !== state.lock.activePhaseId) {
        return rejected(`phaseAttemptId mismatch: got ${params.phaseAttemptId}, expected ${state.lock.activePhaseId}`, ctx.cwd);
      }

      const repoRoot = findRepoRoot(ctx.cwd);
      const maxBytes = Math.min(Math.max(params.max_bytes ?? 40_000, 1), 100_000);
      const maxResults = Math.min(Math.max(params.max_results ?? 100, 1), 500);
      const requestedPath = repoPath(params.path);
      const policy = new PolicyEngine({ repoRoot });
      const action = actionFor({
        runId: state?.runId ?? "no-active-run",
        mode: params.mode,
        resource: requestedPath,
        input: { path: requestedPath },
      });
      const decision = policy.decide(action);
      if (decision.result !== "allow") return rejected(decision.reason, repoRoot, requestedPath);

      let rawText = "";
      let files: string[] = [];
      let truncated = false;
      let bytes = 0;

      if (params.mode === "read_file") {
        const absolute = requestedPath === "." ? fs.realpathSync(repoRoot) : resolveContainedPath(repoRoot, requestedPath);
        if (!fs.statSync(absolute).isFile()) return rejected(`Not a file: ${requestedPath}`, repoRoot, requestedPath);
        const limited = truncateText(fs.readFileSync(absolute, "utf8"), maxBytes);
        rawText = limited.text;
        truncated = limited.truncated;
        bytes = limited.bytes;
        files = [requestedPath];
      } else if (params.mode === "list_files") {
        files = collectFiles(repoRoot, requestedPath, maxResults);
        const limited = truncateText(files.join("\n"), maxBytes);
        rawText = limited.text;
        truncated = limited.truncated || files.length >= maxResults;
        bytes = limited.bytes;
      } else {
        if (!params.query) return rejected("search_text requires query", repoRoot, requestedPath);
        const searched = searchWithRg(repoRoot, params, maxResults, maxBytes);
        const finalSearch = searched.text || searched.files.length > 0 ? searched : searchFallback(repoRoot, params, maxResults, maxBytes);
        rawText = finalSearch.text || "(no matches)";
        files = finalSearch.files;
        truncated = finalSearch.truncated;
        bytes = finalSearch.bytes;
      }

      let visibleText = rawText || "(no output)";
      let dlpScanId: string | null = null;
      if (state) {
        const processed = processModelVisibleText({
          text: visibleText,
          source: `goal_repo_context:${params.mode}:${requestedPath}`,
          classification: "untrusted_data_plane",
          dlp: state.dlp,
          sanitizer: state.sanitizer,
        });
        visibleText = processed.text;
        dlpScanId = processed.dlpSummary.scanId;
        stateManager.updateDlpState(processed.dlp);
        stateManager.updateSanitizationState(processed.sanitizer);

        try {
          stateManager.recordAttestation(attestAction({
            runId: state.runId,
            cycle: state.cycle,
            phase: state.phase,
            artifactPath: stateManager.getArtifactPath(state.cycle, state.phase, `repo-context-${Date.now()}.txt`),
            action,
            outputBytes: visibleText,
            dlpScanId,
            trustClassification: "untrusted_data_plane",
            signing: state.signing,
            sandboxProfile: state.sandbox.profile,
          }));
        } catch {
          // Attestation failures are surfaced by evaluator prerequisites.
        }
      }

      const header = [
        `mode=${params.mode}`,
        `repoRoot=${repoRoot}`,
        `path=${requestedPath}`,
        params.query ? `query=${params.query}` : "",
        `files=${files.length}`,
        `truncated=${truncated ? "yes" : "no"}`,
      ].filter(Boolean).join(" ");

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${visibleText}` }],
        details: {
          mode: params.mode,
          repoRoot,
          path: requestedPath,
          query: params.query,
          files,
          bytes,
          truncated,
          dlpScanId,
          allowed: true,
        } satisfies RepoContextResultDetails,
      };
    },
  });
}

function rejected(reason: string, repoRoot: string, requestedPath = ".") {
  return {
    content: [{ type: "text" as const, text: `REPO CONTEXT BLOCKED: ${reason}` }],
    details: {
      mode: "read_file" as const,
      repoRoot,
      path: requestedPath,
      files: [],
      bytes: 0,
      truncated: false,
      dlpScanId: null,
      allowed: false,
      safetyCheckResult: reason,
    } satisfies RepoContextResultDetails,
  };
}
