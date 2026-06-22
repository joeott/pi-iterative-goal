import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StateManagerAPI } from "./state.js";
import type { FinalizationPolicy } from "./types.js";
import { hashJson, validateReleaseAuthorization } from "./release/controller.js";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";

function log(msg: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [goal_git] ${msg}\n`);
  } catch {}
}

function parseProjectSettings(cwd: string): Record<string, unknown> {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    log(`Failed to parse settings: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function loadFinalizationPolicy(cwd: string): FinalizationPolicy {
  const settings = parseProjectSettings(cwd);
  const iterativeGoal = settings.iterativeGoal && typeof settings.iterativeGoal === "object"
    ? settings.iterativeGoal as Record<string, unknown>
    : {};
  const finalization = iterativeGoal.finalization && typeof iterativeGoal.finalization === "object"
    ? iterativeGoal.finalization as Record<string, unknown>
    : {};

  return {
    allowGitFinalization: finalization.allowGitFinalization === true,
    allowCommit: finalization.allowCommit === true,
    allowPush: finalization.allowPush === true,
    allowPR: finalization.allowPR === true,
    fallback: finalization.fallback === "none" ? "none" : "patch",
  };
}

async function commandAvailable(pi: ExtensionAPI, command: string, cwd: string): Promise<boolean> {
  try {
    const result = await pi.exec("which", [command], { cwd, timeout: 5_000 });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function ghAuthenticated(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  try {
    const result = await pi.exec("gh", ["auth", "status"], { cwd, timeout: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getGitCapability(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  policy: FinalizationPolicy,
): Promise<{
  enabled: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowPR: boolean;
  gitAvailable: boolean;
  ghAvailable: boolean;
  ghAuthenticated: boolean;
  currentBranch: string | null;
}> {
  const gitAvailable = await commandAvailable(pi, "git", ctx.cwd);
  const ghAvailable = await commandAvailable(pi, "gh", ctx.cwd);
  const authenticated = ghAvailable ? await ghAuthenticated(pi, ctx.cwd) : false;
  const branch = gitAvailable ? await currentBranch(pi, ctx.cwd) : null;

  return {
    enabled: policy.allowGitFinalization || policy.allowCommit || policy.allowPush || policy.allowPR,
    allowCommit: policy.allowCommit,
    allowPush: policy.allowPush,
    allowPR: policy.allowPR,
    gitAvailable,
    ghAvailable,
    ghAuthenticated: authenticated,
    currentBranch: branch,
  };
}

export function shouldBlockGitShellCommand(command: string, policy: FinalizationPolicy): string | null {
  const normalized = command.trim();
  if (!/\bgit\b/.test(normalized) && !/\bgh\b/.test(normalized)) return null;
  if (!policy.allowGitFinalization && !policy.allowCommit && !policy.allowPush && !policy.allowPR) return null;
  if (/\bgit\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i.test(normalized)) return null;
  if (/\bgh\s+pr\s+view\b/i.test(normalized)) return null;
  return "Git finalization commands must use goal_git when iterativeGoal.finalization is enabled.";
}

const GoalGitParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("checkout_branch"),
    Type.Literal("add"),
    Type.Literal("commit"),
    Type.Literal("push"),
    Type.Literal("create_pr"),
  ]),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to project root)" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to stage" })),
  branch: Type.Optional(Type.String({ description: "Branch name for checkout or push" })),
  remote: Type.Optional(Type.String({ description: "Remote name for push (default origin)" })),
  message: Type.Optional(Type.String({ description: "Commit message" })),
  title: Type.Optional(Type.String({ description: "PR title" })),
  body: Type.Optional(Type.String({ description: "PR body" })),
  base: Type.Optional(Type.String({ description: "PR base branch" })),
  draft: Type.Optional(Type.Boolean({ description: "Create draft PR", default: false })),
  releaseAuthorizationId: Type.Optional(Type.String({ description: "Required for create_pr; must match the active release authorization" })),
  purpose: Type.String({ description: "Why this git action is needed" }),
});

function missing(field: string): never {
  throw new Error(`Missing required field for goal_git: ${field}`);
}

export function registerGoalGitTool(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
): void {
  pi.registerTool({
    name: "goal_git",
    label: "Goal Git",
    description: "Run guarded git and GitHub finalization actions for iterative-goal runs.",
    promptSnippet: "Run guarded git add/commit/push/PR actions for the iterative goal loop",
    promptGuidelines: [
      "Use goal_git instead of bash or goal_shell for git finalization actions.",
      "Follow the repo's iterativeGoal.finalization policy for commit, push, and PR creation.",
    ],
    parameters: GoalGitParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = stateManager.getState();
      const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
      const purpose = String(params.purpose ?? "");
      const action = params.action as string;
      const policy = state?.finalizationPolicy ?? loadFinalizationPolicy(cwd);
      const gitInfo = await getGitCapability(pi, ctx, policy);

      const detailsBase = {
        action,
        cwd,
        purpose,
        branch: typeof params.branch === "string" ? params.branch : null,
      };

      if (!gitInfo.gitAvailable) {
        return {
          content: [{ type: "text" as const, text: "git is not available on this machine." }],
          details: { ...detailsBase, ok: false },
          isError: true,
        };
      }

      const exec = async (command: string, args: string[]) =>
        pi.exec(command, args, {
          cwd,
          signal: signal ?? undefined,
          timeout: 120_000,
        });

      try {
        switch (action) {
          case "status": {
            const result = await exec("git", ["status", "--short", "--branch"]);
            return {
              content: [{ type: "text" as const, text: result.stdout || "(no output)" }],
              details: { ...detailsBase, ok: result.code === 0, code: result.code },
              isError: result.code !== 0,
            };
          }
          case "checkout_branch": {
            if (!policy.allowGitFinalization) throw new Error("Git branch creation is disabled by finalization policy.");
            const branch = typeof params.branch === "string" ? params.branch : missing("branch");
            const result = await exec("git", ["checkout", "-b", branch]);
            return {
              content: [{ type: "text" as const, text: result.stdout || result.stderr || `Created branch ${branch}` }],
              details: { ...detailsBase, ok: result.code === 0, code: result.code, branch },
              isError: result.code !== 0,
            };
          }
          case "add": {
            if (!policy.allowGitFinalization) throw new Error("git add is disabled by finalization policy.");
            const paths = Array.isArray(params.paths) && params.paths.length > 0 ? params.paths as string[] : missing("paths");
            const result = await exec("git", ["add", ...paths]);
            return {
              content: [{ type: "text" as const, text: result.stdout || result.stderr || `Staged ${paths.join(", ")}` }],
              details: { ...detailsBase, ok: result.code === 0, code: result.code, paths },
              isError: result.code !== 0,
            };
          }
          case "commit": {
            if (!policy.allowCommit) throw new Error("git commit is disabled by finalization policy.");
            const message = typeof params.message === "string" ? params.message : missing("message");
            const result = await exec("git", ["commit", "-m", message]);
            return {
              content: [{ type: "text" as const, text: result.stdout || result.stderr || `Committed with message: ${message}` }],
              details: { ...detailsBase, ok: result.code === 0, code: result.code, message },
              isError: result.code !== 0,
            };
          }
          case "push": {
            if (!policy.allowPush) throw new Error("git push is disabled by finalization policy.");
            const remote = typeof params.remote === "string" ? params.remote : "origin";
            const branch = typeof params.branch === "string"
              ? params.branch
              : (await currentBranch(pi, cwd)) ?? missing("branch");
            const result = await exec("git", ["push", "-u", remote, branch]);
            return {
              content: [{ type: "text" as const, text: result.stdout || result.stderr || `Pushed ${branch} to ${remote}` }],
              details: { ...detailsBase, ok: result.code === 0, code: result.code, branch, remote },
              isError: result.code !== 0,
            };
          }
          case "create_pr": {
            if (!policy.allowPR) throw new Error("PR creation is disabled by finalization policy.");
            if (!state) throw new Error("PR creation requires an active iterative-goal run.");
            const releaseAuthorizationId = typeof params.releaseAuthorizationId === "string" ? params.releaseAuthorizationId : missing("releaseAuthorizationId");
            if (!state.releaseAuthorization || state.releaseAuthorization.id !== releaseAuthorizationId) {
              throw new Error("PR creation requires a matching ReleaseAuthorization from the pre-PR release gate.");
            }
            const releaseAuthCheck = await validateReleaseAuthorization({
              pi,
              ctx,
              authorization: state.releaseAuthorization,
              runId: state.runId,
              expected: {
                planHash: hashJson(state.artifacts.plans.at(-1) ?? null),
                requirementsHash: hashJson({ goal: state.goal, criterion: state.goalCriterion }),
                gateVerdictHash: hashJson({ evaluator: state.evaluator.lastVerdict }),
                evidenceRootHash: hashJson(state.artifacts),
              },
            });
            if (!releaseAuthCheck.ok) {
              throw new Error(releaseAuthCheck.reason);
            }
            if (!gitInfo.ghAvailable) throw new Error("gh is not installed.");
            if (!gitInfo.ghAuthenticated) throw new Error("gh is installed but not authenticated.");
            const title = typeof params.title === "string" ? params.title : missing("title");
            const body = typeof params.body === "string" ? params.body : missing("body");
            const args = ["pr", "create", "--title", title, "--body", body];
            if (typeof params.base === "string" && params.base.trim()) args.push("--base", params.base.trim());
            if (typeof params.branch === "string" && params.branch.trim()) args.push("--head", params.branch.trim());
            if (params.draft === true) args.push("--draft");
            const result = await exec("gh", args);
            return {
              content: [{ type: "text" as const, text: result.stdout || result.stderr || "PR created." }],
              details: { ...detailsBase, ok: result.code === 0, code: result.code, title, base: params.base ?? null },
              isError: result.code !== 0,
            };
          }
          default:
            throw new Error(`Unsupported goal_git action: ${action}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`goal_git ${action} failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `goal_git failed: ${message}` }],
          details: { ...detailsBase, ok: false },
          isError: true,
        };
      }
    },
  });
}
