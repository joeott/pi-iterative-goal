import * as path from "node:path";
import {
  pathInScopes,
  type PathScope,
  normalizeRepoPath,
  resolveContainedPath,
} from "../domain/path-scope.js";
import { checkCommand } from "../safety.js";

export type Effect =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "process.exec"
  | "network.fetch"
  | "browser.interact"
  | "vision.inspect"
  | "git.branch"
  | "git.stage"
  | "git.commit"
  | "git.push"
  | "git.pr.open"
  | "cloud.read"
  | "cloud.mutate"
  | "secret.read"
  | "package.install"
  | "ci.read"
  | "ci.trigger";

export interface ActorIdentity {
  kind: "kernel" | "agent" | "tool" | "user";
  id: string;
}

export interface ResourceDescriptor {
  type: "path" | "command" | "url" | "git" | "cloud" | "unknown";
  value: string;
}

export interface CapabilityLease {
  id: string;
  runId: string;
  taskId?: string;
  effect: Effect;
  resource: ResourceDescriptor;
  maxUses: number;
  expiresAt: string;
}

export interface ActionRequest {
  id: string;
  actor: ActorIdentity;
  runId: string;
  taskId?: string;
  effect: Effect;
  resource: ResourceDescriptor;
  input: unknown;
  purpose: string;
  risk: "read" | "write" | "privileged";
  dataClassification: "public" | "internal" | "secret";
  allowedPaths?: PathScope[];
}

export interface PolicyDecision {
  result: "allow" | "deny" | "require_approval" | "transform";
  ruleIds: string[];
  reason: string;
  lease?: CapabilityLease;
  transformedInput?: unknown;
}

export interface PolicyContext {
  repoRoot: string;
  protectedBranches?: string[];
  allowNetworkHosts?: string[];
}

export class PolicyEngine {
  constructor(private readonly context: PolicyContext) {}

  decide(request: ActionRequest): PolicyDecision {
    const rules: string[] = [];

    if (request.dataClassification === "secret" && request.effect !== "secret.read") {
      return deny("policy.secret.no-ambient-use", "Secret data cannot be passed to non-secret capabilities.");
    }

    if (request.effect === "fs.write" || request.effect === "fs.delete") {
      rules.push("policy.fs.scope");
      const resourcePath = request.resource.value;
      try {
        const normalized = normalizeRepoPath(resourcePath);
        resolveContainedPath(this.context.repoRoot, normalized);
        if (!request.allowedPaths || !pathInScopes(normalized, request.allowedPaths)) {
          return deny("policy.fs.scope", `Filesystem ${request.effect} denied outside active task path scope: ${resourcePath}`);
        }
      } catch (err) {
        return deny("policy.fs.scope", err instanceof Error ? err.message : String(err));
      }
    }

    if (request.effect === "process.exec") {
      rules.push("policy.process.no-shell-strings");
      if (!request.input || typeof request.input !== "object" || !("executable" in request.input)) {
        return deny("policy.process.no-shell-strings", "Process execution requires executable-plus-argv input.");
      }
      const command = request.resource.value;
      const input = request.input as Record<string, unknown>;
      const safety = checkCommand(
        command,
        input.allowDestructive === true,
        input.allowGitFinalization === true,
      );
      if (!safety.allowed) {
        return deny("policy.process.safety", safety.reason ?? "Process command denied by safety policy.");
      }
    }

    if (request.effect === "package.install") {
      return deny("policy.package.install", "Package installation must be represented in an approved plan before execution.");
    }

    if (request.effect === "git.pr.open") {
      return deny("policy.git.pr.release-auth", "PR creation requires a current ReleaseAuthorization.");
    }

    if (request.effect === "cloud.mutate" || request.effect === "secret.read") {
      return {
        result: "require_approval",
        ruleIds: [`policy.${request.effect}.approval`],
        reason: `${request.effect} requires explicit operator approval.`,
      };
    }

    if (request.effect === "network.fetch") {
      rules.push("policy.network.allowlist");
      try {
        const url = new URL(request.resource.value);
        const hostAllowed = this.context.allowNetworkHosts?.includes(url.hostname) ?? false;
        if (!hostAllowed) return deny("policy.network.allowlist", `Network destination is not allowlisted: ${url.hostname}`);
      } catch {
        return deny("policy.network.allowlist", `Invalid URL: ${request.resource.value}`);
      }
    }

    return {
      result: "allow",
      ruleIds: rules.length > 0 ? rules : ["policy.default.allow"],
      reason: "Allowed by policy.",
      lease: {
        id: `${request.id}:lease`,
        runId: request.runId,
        taskId: request.taskId,
        effect: request.effect,
        resource: request.resource,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    };

    function deny(ruleId: string, reason: string): PolicyDecision {
      return { result: "deny", ruleIds: [ruleId], reason };
    }
  }
}

export function commandResource(executable: string, argv: string[]): ResourceDescriptor {
  return { type: "command", value: [executable, ...argv].join(" ") };
}

export function pathResource(repoRelativePath: string): ResourceDescriptor {
  return { type: "path", value: repoRelativePath };
}

export function gitResource(action: string): ResourceDescriptor {
  return { type: "git", value: action };
}
