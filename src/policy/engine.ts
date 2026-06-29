import * as path from "node:path";
import {
  pathInScopes,
  type PathScope,
  normalizeRepoPath,
  resolveContainedPath,
} from "../domain/path-scope.js";
import { checkCommand, isPackageInstallCommand } from "../safety.js";
import { assessCasUnifyCommand } from "../cyber-runtime.js";

export type Effect =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "process.exec"
  | "network.fetch"
  | "browser.interact"
  | "vision.inspect"
  | "mcp.invoke"
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
  type: "path" | "command" | "url" | "git" | "cloud" | "mcp" | "unknown";
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

    if (request.effect === "fs.read" || request.effect === "fs.write" || request.effect === "fs.delete") {
      rules.push("policy.fs.scope");
      const resourcePath = request.resource.value;
      const inputPath = stringInput(request.input, "path");
      if (inputPath && inputPath !== resourcePath) {
        return deny("policy.resource.input-match", `Filesystem resource path does not match input.path: ${resourcePath} !== ${inputPath}`);
      }
      if (request.effect === "fs.write" || request.effect === "fs.delete") {
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
    }

    if (request.effect === "process.exec") {
      rules.push("policy.process.no-shell-strings");
      if (!request.input || typeof request.input !== "object" || !("executable" in request.input)) {
        return deny("policy.process.no-shell-strings", "Process execution requires executable-plus-argv input.");
      }
      const command = request.resource.value;
      const input = request.input as Record<string, unknown>;
      const executable = typeof input.executable === "string" ? input.executable : "";
      const argv = Array.isArray(input.argv) && input.argv.every((item) => typeof item === "string")
        ? input.argv as string[]
        : [];
      const inputCommand = commandResource(executable, argv).value;
      if (inputCommand !== command) {
        return deny("policy.resource.input-match", "Process resource command does not match executable-plus-argv input.");
      }
      if (isPackageInstallCommand(command)) {
        return deny("policy.package.install", "Package installation must use an approved package.install capability with planned lockfile effects.");
      }
      const casBlock = assessCasUnifyCommand(command);
      if (casBlock) {
        return deny("policy.cas_unify.route", casBlock);
      }
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

    if (request.effect === "git.branch") {
      rules.push("policy.git.branch.finalization");
      if (!inputFlag(request.input, "allowGitFinalization")) return deny("policy.git.branch.finalization", "Git branch changes require finalization policy approval.");
    }

    if (request.effect === "git.stage") {
      rules.push("policy.git.stage.finalization");
      if (!inputFlag(request.input, "allowGitFinalization")) return deny("policy.git.stage.finalization", "Git staging requires finalization policy approval.");
    }

    if (request.effect === "git.commit") {
      rules.push("policy.git.commit.finalization");
      if (!inputFlag(request.input, "allowCommit")) return deny("policy.git.commit.finalization", "Git commit requires commit policy approval.");
    }

    if (request.effect === "git.push") {
      rules.push("policy.git.push.finalization");
      if (!inputFlag(request.input, "allowPush")) return deny("policy.git.push.finalization", "Git push requires push policy approval.");
    }

    if (request.effect === "git.pr.open") {
      rules.push("policy.git.pr.release-auth");
      if (!inputFlag(request.input, "releaseAuthorizationValid")) return deny("policy.git.pr.release-auth", "PR creation requires a current ReleaseAuthorization.");
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
      const inputUrl = stringInput(request.input, "url");
      if (inputUrl && inputUrl !== request.resource.value) {
        return deny("policy.resource.input-match", `Network resource URL does not match input.url: ${request.resource.value} !== ${inputUrl}`);
      }
      try {
        const url = parseGovernedUrl(request.resource.value);
        if (isPrivateOrMetadataHost(url.hostname)) {
          return deny("policy.network.private-address", `Network destination is private or metadata-like: ${url.hostname}`);
        }
        const hostAllowed = this.context.allowNetworkHosts?.includes(url.hostname) ?? false;
        if (!hostAllowed) return deny("policy.network.allowlist", `Network destination is not allowlisted: ${url.hostname}`);
      } catch (err) {
        return deny("policy.network.allowlist", err instanceof Error ? err.message : `Invalid URL: ${request.resource.value}`);
      }
    }

    if (request.effect === "browser.interact") {
      rules.push("policy.browser.approval");
      if (!inputFlag(request.input, "allowBrowserInteraction")) {
        return deny("policy.browser.approval", "Browser interaction requires an explicit browser capability approval.");
      }
      if (request.resource.type === "url") {
        const inputUrl = stringInput(request.input, "url");
        if (inputUrl && inputUrl !== request.resource.value) {
          return deny("policy.resource.input-match", `Browser resource URL does not match input.url: ${request.resource.value} !== ${inputUrl}`);
        }
        try {
          const url = parseGovernedUrl(request.resource.value);
          if (isPrivateOrMetadataHost(url.hostname)) {
            return deny("policy.browser.private-address", `Browser destination is private or metadata-like: ${url.hostname}`);
          }
          const hostAllowed = this.context.allowNetworkHosts?.includes(url.hostname) ?? false;
          if (!hostAllowed) return deny("policy.browser.allowlist", `Browser destination is not allowlisted: ${url.hostname}`);
        } catch (err) {
          return deny("policy.browser.allowlist", err instanceof Error ? err.message : `Invalid browser URL: ${request.resource.value}`);
        }
      }
    }

    if (request.effect === "mcp.invoke") {
      rules.push("policy.mcp.approval");
      const serverId = stringInput(request.input, "serverId");
      const toolName = stringInput(request.input, "toolName");
      if (serverId && toolName && request.resource.value !== `${serverId}/${toolName}`) {
        return deny("policy.resource.input-match", "MCP resource does not match input serverId/toolName.");
      }
      if (!inputFlag(request.input, "allowMcpInvoke")) {
        return deny("policy.mcp.approval", "MCP invocation requires an explicit provider-scoped approval.");
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

function inputFlag(input: unknown, name: string): boolean {
  return !!input && typeof input === "object" && (input as Record<string, unknown>)[name] === true;
}

function stringInput(input: unknown, name: string): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

function parseGovernedUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  return url;
}

function isPrivateOrMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.startsWith("::ffff:")) return true;
  if (host === "localhost" || host === "metadata.google.internal") return true;
  if (host === "169.254.169.254" || host === "0.0.0.0" || host === "::1") return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  return !!match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31;
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
