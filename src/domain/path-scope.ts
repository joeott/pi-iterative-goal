import * as fs from "node:fs";
import * as path from "node:path";

export type PathScope =
  | { kind: "exact"; path: string }
  | { kind: "glob"; pattern: string };

const SAFE_REPO_PATH = /^[A-Za-z0-9._/@+-][A-Za-z0-9._/@+\-]*$/;

export function normalizeRepoPath(raw: string): string {
  const clean = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!clean || clean.startsWith("/") || clean.includes("\0")) {
    throw new Error(`Path must be repository-relative: ${raw}`);
  }
  const normalized = path.posix.normalize(clean);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Path escapes repository root: ${raw}`);
  }
  if (!SAFE_REPO_PATH.test(normalized)) {
    throw new Error(`Unsupported path characters: ${raw}`);
  }
  return normalized;
}

export function exactPathScope(raw: string): PathScope {
  return { kind: "exact", path: normalizeRepoPath(raw) };
}

export function globPathScope(raw: string): PathScope {
  const pattern = normalizeRepoPath(raw);
  if (!pattern.includes("*")) return exactPathScope(pattern);
  return { kind: "glob", pattern };
}

export function parsePathScope(raw: string): PathScope {
  return raw.includes("*") ? globPathScope(raw) : exactPathScope(raw);
}

export function resolveContainedPath(repoRoot: string, repoRelativePath: string): string {
  const normalized = normalizeRepoPath(repoRelativePath);
  const rootReal = fs.realpathSync(repoRoot);
  const target = path.resolve(rootReal, normalized);
  const anchor = nearestExistingPath(target);
  const anchorReal = fs.realpathSync(anchor);
  if (anchorReal !== rootReal && !anchorReal.startsWith(rootReal + path.sep)) {
    throw new Error(`Path escapes repository root through symlink: ${repoRelativePath}`);
  }
  return target;
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function pathMatchesScope(repoRelativePath: string, scope: PathScope): boolean {
  const normalized = normalizeRepoPath(repoRelativePath);
  if (scope.kind === "exact") return normalized === scope.path;
  return globToRegExp(scope.pattern).test(normalized);
}

export function pathInScopes(repoRelativePath: string, scopes: PathScope[]): boolean {
  return scopes.some((scope) => pathMatchesScope(repoRelativePath, scope));
}

export function extractPathScopesFromPlanText(planContent: string): PathScope[] {
  const paths = new Set<string>();
  const patterns = [
    /`([A-Za-z0-9._/@+\-*]+)`/g,
    /["']([A-Za-z0-9._/@+\-*]+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of planContent.matchAll(pattern)) {
      const candidate = match[1];
      if (!candidate || !looksLikeRepoPath(candidate)) continue;
      try {
        paths.add(normalizeRepoPath(candidate));
      } catch {
        // Ignore text that only looks path-like.
      }
    }
  }
  return [...paths].map(parsePathScope);
}

function looksLikeRepoPath(candidate: string): boolean {
  if (candidate.includes("/") || candidate.includes(".") || candidate.includes("*")) return true;
  return new Set([
    "Dockerfile",
    "Makefile",
    "Procfile",
    "CODEOWNERS",
    "LICENSE",
    "NOTICE",
    "README",
  ]).has(candidate);
}

export function serializePathScope(scope: PathScope): string {
  return scope.kind === "exact" ? scope.path : scope.pattern;
}
