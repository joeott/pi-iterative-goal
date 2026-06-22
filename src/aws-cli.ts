import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StateManagerAPI } from "./state.js";
import type {
  AwsCliConfig,
  AwsCliMutatingFamily,
  AwsCliPreflight,
  AwsCliProfileResolutionStep,
} from "./types.js";
import { CapabilityBroker } from "./capabilities/broker.js";
import { commandResource, PolicyEngine, type PolicyDecision } from "./policy/engine.js";
import { logDebug } from "./logging.js";

function log(msg: string) {
  logDebug("goal_aws_cli", msg);
}

export const DEFAULT_AWS_CLI_CONFIG: AwsCliConfig = {
  enabled: false,
  defaultRegion: "us-east-1",
  profileResolutionOrder: ["explicit", "env", "configured"],
  profileCandidates: [],
  requireSessionManagerPlugin: true,
  allowMutatingFamilies: [],
  preflight: null,
};

export interface AwsCommandAssessment {
  allowed: boolean;
  isMutation: boolean;
  family: AwsCliMutatingFamily | "read-only" | "blocked" | "unknown";
  reason?: string;
}

interface BrokeredExecResult {
  ok: boolean;
  result?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
  decision: PolicyDecision;
  error?: string;
}

function parseProjectSettings(cwd: string): Record<string, unknown> {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    log(`Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function isProfileResolutionStep(value: unknown): value is AwsCliProfileResolutionStep {
  return value === "explicit" || value === "env" || value === "configured";
}

function isMutatingFamily(value: unknown): value is AwsCliMutatingFamily {
  return value === "ec2-start-stop-wait"
    || value === "ssm-session"
    || value === "ssm-send-command"
    || value === "s3-sync"
    || value === "s3-cp"
    || value === "logs-tail";
}

export function loadAwsCliConfig(cwd: string): AwsCliConfig {
  const settings = parseProjectSettings(cwd);
  const iterativeGoal = settings.iterativeGoal && typeof settings.iterativeGoal === "object"
    ? settings.iterativeGoal as Record<string, unknown>
    : {};
  const awsCli = iterativeGoal.awsCli && typeof iterativeGoal.awsCli === "object"
    ? iterativeGoal.awsCli as Record<string, unknown>
    : {};

  const profileResolutionOrder = Array.isArray(awsCli.profileResolutionOrder)
    ? awsCli.profileResolutionOrder.filter(isProfileResolutionStep)
    : DEFAULT_AWS_CLI_CONFIG.profileResolutionOrder;
  const legacyProfileCandidates = Array.isArray(awsCli.profileResolutionOrder)
    ? awsCli.profileResolutionOrder
      .filter((value): value is string => typeof value === "string" && !isProfileResolutionStep(value))
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const profileCandidates = Array.isArray(awsCli.profileCandidates)
    ? awsCli.profileCandidates
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
    : legacyProfileCandidates;
  const allowMutatingFamilies = Array.isArray(awsCli.allowMutatingFamilies)
    ? awsCli.allowMutatingFamilies.filter(isMutatingFamily)
    : DEFAULT_AWS_CLI_CONFIG.allowMutatingFamilies;

  return {
    enabled: awsCli.enabled === true,
    defaultRegion: typeof awsCli.defaultRegion === "string" && awsCli.defaultRegion.trim()
      ? awsCli.defaultRegion.trim()
      : DEFAULT_AWS_CLI_CONFIG.defaultRegion,
    profileResolutionOrder: profileResolutionOrder.length > 0
      ? profileResolutionOrder
      : DEFAULT_AWS_CLI_CONFIG.profileResolutionOrder,
    profileCandidates: [...new Set(profileCandidates)],
    requireSessionManagerPlugin: awsCli.requireSessionManagerPlugin !== false,
    allowMutatingFamilies,
    preflight: null,
  };
}

async function isCommandAvailable(
  pi: ExtensionAPI,
  command: string,
  cwd: string,
): Promise<boolean> {
  try {
    const action = await execThroughBroker(pi, {
      cwd,
      command: "which",
      args: [command],
      timeout: 5_000,
      runId: "aws-preflight",
      purpose: `AWS preflight: locate ${command}`,
    });
    return action.ok && !!action.result && action.result.code === 0 && action.result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function listAwsProfiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  try {
    const action = await execThroughBroker(pi, {
      cwd,
      command: "aws",
      args: ["configure", "list-profiles"],
      timeout: 10_000,
      runId: "aws-preflight",
      purpose: "AWS preflight: list profiles",
    });
    if (!action.ok || !action.result) return [];
    const result = action.result;
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function candidateProfiles(
  config: AwsCliConfig,
  explicitProfile?: string,
): string[] {
  if (explicitProfile && explicitProfile.trim()) return [explicitProfile.trim()];

  const profiles: string[] = [];
  for (const step of config.profileResolutionOrder) {
    if (step === "explicit") continue;
    if (step === "env" && process.env.AWS_PROFILE?.trim()) profiles.push(process.env.AWS_PROFILE.trim());
    if (step === "configured") profiles.push(...config.profileCandidates);
  }
  return [...new Set(profiles)];
}

async function resolveIdentity(
  pi: ExtensionAPI,
  cwd: string,
  profile: string,
  region: string,
): Promise<{ account: string; arn: string; userId: string } | null> {
  try {
    const action = await execThroughBroker(pi, {
      cwd,
      command: "aws",
      args: [
        "sts",
        "get-caller-identity",
        "--profile",
        profile,
        "--region",
        region,
        "--output",
        "json",
      ],
      timeout: 15_000,
      runId: "aws-preflight",
      purpose: "AWS preflight: resolve caller identity",
    });
    if (!action.ok || !action.result) return null;
    const result = action.result;
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    return {
      account: String(parsed.Account ?? ""),
      arn: String(parsed.Arn ?? ""),
      userId: String(parsed.UserId ?? ""),
    };
  } catch {
    return null;
  }
}

async function execThroughBroker(
  pi: ExtensionAPI,
  params: {
    cwd: string;
    command: string;
    args: string[];
    timeout: number;
    runId: string;
    purpose: string;
    allowDestructive?: boolean;
    signal?: AbortSignal;
  },
): Promise<BrokeredExecResult> {
  const policy = new PolicyEngine({ repoRoot: params.cwd });
  const broker = new CapabilityBroker(policy);
  const action = await broker.invoke({
    id: `goal_aws_cli:${Date.now()}`,
    actor: { kind: "tool", id: "goal_aws_cli" },
    runId: params.runId,
    effect: "process.exec",
    resource: commandResource(params.command, params.args),
    input: {
      executable: params.command,
      argv: params.args,
      cwd: params.cwd,
      allowDestructive: params.allowDestructive === true,
      allowGitFinalization: false,
    },
    purpose: params.purpose,
    risk: params.allowDestructive === true ? "write" : "read",
    dataClassification: "internal",
  }, async () => pi.exec(params.command, params.args, {
    cwd: params.cwd,
    signal: params.signal,
    timeout: params.timeout,
  }), params.signal);

  return {
    ok: action.ok && !!action.output,
    result: action.output,
    decision: action.decision,
    error: action.error,
  };
}
export async function preflightAwsCli(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  config: AwsCliConfig,
): Promise<AwsCliPreflight> {
  const checkedAt = new Date().toISOString();
  if (!config.enabled) {
    return {
      enabled: false,
      cliAvailable: false,
      sessionManagerPluginAvailable: false,
      availableProfiles: [],
      resolvedProfile: null,
      resolvedRegion: config.defaultRegion,
      identity: null,
      issues: [],
      checkedAt,
    };
  }

  const cliAvailable = await isCommandAvailable(pi, "aws", ctx.cwd);
  const pluginAvailable = config.requireSessionManagerPlugin
    ? await isCommandAvailable(pi, "session-manager-plugin", ctx.cwd)
    : true;
  const availableProfiles = cliAvailable ? await listAwsProfiles(pi, ctx.cwd) : [];
  const resolvedRegion = process.env.AWS_REGION?.trim()
    || process.env.AWS_DEFAULT_REGION?.trim()
    || config.defaultRegion;

  const issues: string[] = [];
  let resolvedProfile: string | null = null;
  let identity: AwsCliPreflight["identity"] = null;

  if (!cliAvailable) {
    issues.push("aws CLI not found");
  }
  if (config.requireSessionManagerPlugin && !pluginAvailable) {
    issues.push("session-manager-plugin not found");
  }

  if (cliAvailable) {
    for (const candidate of candidateProfiles(config)) {
      const stsIdentity = await resolveIdentity(pi, ctx.cwd, candidate, resolvedRegion);
      if (stsIdentity) {
        resolvedProfile = candidate;
        identity = stsIdentity;
        break;
      }
    }
  }

  if (cliAvailable && !resolvedProfile) {
    issues.push("no usable AWS profile resolved; run aws sso login --profile <profile> or set AWS_PROFILE");
  }

  return {
    enabled: true,
    cliAvailable,
    sessionManagerPluginAvailable: pluginAvailable,
    availableProfiles,
    resolvedProfile,
    resolvedRegion,
    identity,
    issues,
    checkedAt,
  };
}

export function withAwsCliPreflight(
  config: AwsCliConfig,
  preflight: AwsCliPreflight,
): AwsCliConfig {
  return {
    ...config,
    preflight,
  };
}

export function assessAwsCliArgs(
  args: string[],
  config: AwsCliConfig,
  allowMutation: boolean,
): AwsCommandAssessment {
  const [service = "", command = ""] = args;
  if (!service) {
    return { allowed: false, isMutation: false, family: "unknown", reason: "AWS args must include a service and command." };
  }

  if (service === "iam") {
    return { allowed: false, isMutation: true, family: "blocked", reason: "IAM mutations are blocked in the harness." };
  }
  if (service === "cloudformation" && /^((delete|update|create|execute)-|deploy$)/.test(command)) {
    return { allowed: false, isMutation: true, family: "blocked", reason: "CloudFormation mutation is blocked in the harness." };
  }
  if (service === "s3" && command === "rm") {
    return { allowed: false, isMutation: true, family: "blocked", reason: "aws s3 rm is always blocked." };
  }

  let family: AwsCommandAssessment["family"] = "read-only";
  let isMutation = false;

  if (service === "ec2" && ["start-instances", "stop-instances", "wait"].includes(command)) {
    family = "ec2-start-stop-wait";
    isMutation = true;
  } else if (service === "ssm" && command === "start-session") {
    family = "ssm-session";
    isMutation = true;
  } else if (service === "ssm" && command === "send-command") {
    family = "ssm-send-command";
    isMutation = true;
  } else if (service === "s3" && command === "sync") {
    family = "s3-sync";
    isMutation = true;
  } else if (service === "s3" && command === "cp") {
    family = "s3-cp";
    isMutation = true;
  } else if (service === "logs" && command === "tail") {
    family = "logs-tail";
    isMutation = true;
  }

  if (!isMutation) {
    return { allowed: true, isMutation: false, family };
  }
  if (!allowMutation) {
    return {
      allowed: false,
      isMutation: true,
      family,
      reason: `AWS mutation ${family} requires allowMutation=true.`,
    };
  }
  if (!config.allowMutatingFamilies.includes(family as AwsCliMutatingFamily)) {
    return {
      allowed: false,
      isMutation: true,
      family,
      reason: `AWS mutation family ${family} is not enabled in local harness config.`,
    };
  }
  return { allowed: true, isMutation: true, family };
}

export function shouldBlockAwsShellCommand(command: string, config: AwsCliConfig): string | null {
  if (!config.enabled) return null;
  const normalized = command.trim();
  if (!/\baws\b/.test(normalized)) return null;
  if (!/\baws\s+/.test(normalized)) return null;
  return "AWS CLI commands must use goal_aws_cli when iterativeGoal.awsCli is enabled.";
}

const GoalAwsCliParams = Type.Object({
  args: Type.Array(Type.String(), { description: "AWS CLI argv without the leading aws binary" }),
  purpose: Type.String({ description: "Why this AWS command is needed" }),
  profile: Type.Optional(Type.String({ description: "Optional explicit AWS profile override" })),
  region: Type.Optional(Type.String({ description: "Optional AWS region override" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to project root)" })),
  allowMutation: Type.Optional(Type.Boolean({ description: "Required for approved mutating AWS families", default: false })),
});

export function registerGoalAwsCliTool(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
): void {
  pi.registerTool({
    name: "goal_aws_cli",
    label: "Goal AWS CLI",
    description: "Run approved AWS CLI commands with profile resolution, preflight, and safety policies.",
    promptSnippet: "Run guarded AWS CLI commands for the iterative goal loop",
    promptGuidelines: [
      "Use goal_aws_cli instead of bash or goal_shell for AWS operations.",
      "Read-only AWS calls are allowed by default. Approved mutating families require allowMutation=true.",
    ],
    parameters: GoalAwsCliParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = stateManager.getState();
      const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
      const args = (params.args as string[] | undefined) ?? [];
      const purpose = String(params.purpose ?? "");
      const explicitProfile = typeof params.profile === "string" ? params.profile : undefined;
      const explicitRegion = typeof params.region === "string" ? params.region : undefined;
      const allowMutation = params.allowMutation === true;
      const config = state?.config.awsCli ?? loadAwsCliConfig(cwd);

      if (!config.enabled) {
        return {
          content: [{ type: "text" as const, text: "AWS CLI support is not enabled in this repo's iterativeGoal.awsCli config." }],
          details: {
            allowed: false,
            family: "blocked",
            purpose,
            args,
            profile: explicitProfile ?? null,
            region: explicitRegion ?? null,
          },
          isError: true,
        };
      }

      const preflight = await preflightAwsCli(pi, ctx, config);
      const effectiveConfig = withAwsCliPreflight(config, preflight);
      if (state) {
        state.config.awsCli = effectiveConfig;
        stateManager.persistAll();
      }

      const assessment = assessAwsCliArgs(args, effectiveConfig, allowMutation);
      if (!assessment.allowed) {
        return {
          content: [{ type: "text" as const, text: `AWS SAFETY BLOCK: ${assessment.reason}` }],
          details: {
            allowed: false,
            family: assessment.family,
            purpose,
            args,
            profile: explicitProfile ?? preflight.resolvedProfile,
            region: explicitRegion ?? preflight.resolvedRegion,
          },
          isError: true,
        };
      }

      const profile = explicitProfile ?? preflight.resolvedProfile;
      const region = explicitRegion ?? preflight.resolvedRegion ?? effectiveConfig.defaultRegion;
      if (!preflight.cliAvailable) {
        return {
          content: [{ type: "text" as const, text: "AWS CLI is not available on this machine." }],
          details: {
            allowed: false,
            family: "blocked",
            purpose,
            args,
            profile,
            region,
          },
          isError: true,
        };
      }
      if (!profile) {
        return {
          content: [{ type: "text" as const, text: `No usable AWS profile resolved. ${preflight.issues.join(" ")}` }],
          details: {
            allowed: false,
            family: "blocked",
            purpose,
            args,
            profile: null,
            region,
          },
          isError: true,
        };
      }
      if (effectiveConfig.requireSessionManagerPlugin && assessment.family === "ssm-session" && !preflight.sessionManagerPluginAvailable) {
        return {
          content: [{ type: "text" as const, text: "session-manager-plugin is required for aws ssm start-session but is not available." }],
          details: {
            allowed: false,
            family: assessment.family,
            purpose,
            args,
            profile,
            region,
          },
          isError: true,
        };
      }

      const finalArgs = [...args];
      if (!finalArgs.includes("--profile")) {
        finalArgs.push("--profile", profile);
      }
      if (!finalArgs.includes("--region") && region) {
        finalArgs.push("--region", region);
      }

      try {
        const action = await execThroughBroker(pi, {
          cwd,
          command: "aws",
          args: finalArgs,
          timeout: 120_000,
          runId: state?.runId ?? "goal_aws_cli",
          purpose,
          allowDestructive: assessment.isMutation,
          signal: signal ?? undefined,
        });
        if (!action.ok || !action.result) {
          return {
            content: [{ type: "text" as const, text: `AWS CLI execution blocked: ${action.error ?? action.decision.reason}` }],
            details: {
              allowed: false,
              family: assessment.family,
              purpose,
              args,
              profile,
              region,
              policyDecision: action.decision,
            },
            isError: true,
          };
        }
        const result = action.result;
        const truncated = result.stdout.length > 50_000 || result.stderr.length > 50_000;
        const stdoutDisplay = result.stdout.slice(0, 50_000);
        const stderrDisplay = result.stderr.slice(0, 50_000);

        const evidence = {
          timestamp: new Date().toISOString(),
          purpose,
          args,
          executedArgs: finalArgs,
          profile,
          region,
          family: assessment.family,
          isMutation: assessment.isMutation,
          policyDecision: action.decision,
          exitCode: result.code,
          killed: result.killed ?? false,
          stdout: stdoutDisplay,
          stderr: stderrDisplay,
          truncated,
        };

        if (state) {
          try {
            const evidencePath = stateManager.getArtifactPath(
              state.cycle,
              state.phase,
              `aws-invocation-${Date.now()}.json`,
            );
            fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
          } catch (err) {
            log(`Failed to persist AWS evidence: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        let text = "";
        if (result.code === 0) {
          text = stdoutDisplay || "(no output)";
        } else {
          text = [
            `Exit code: ${result.code}`,
            stdoutDisplay ? `STDOUT:\n${stdoutDisplay}` : "",
            stderrDisplay ? `STDERR:\n${stderrDisplay}` : "",
          ].filter(Boolean).join("\n\n");
        }
        if (truncated) {
          text += "\n\n[Output truncated at 50KB.]";
        }

        return {
          content: [{ type: "text" as const, text }],
          details: {
            allowed: true,
            family: assessment.family,
            isMutation: assessment.isMutation,
            profile,
            region,
            purpose,
            exitCode: result.code,
            killed: result.killed ?? false,
            truncated,
            policyDecision: action.decision,
          },
          isError: result.code !== 0,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`AWS exec failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `AWS CLI execution failed: ${message}` }],
          details: {
            allowed: false,
            family: assessment.family,
            purpose,
            args,
            profile,
            region,
          },
          isError: true,
        };
      }
    },
  });
}
