import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandSpecFromShellWords } from "../domain/verification.js";
import { shouldBlockAwsShellCommand } from "../aws-cli.js";
import { shouldBlockGitShellCommand } from "../git.js";
import { commandResource, PolicyEngine } from "../policy/engine.js";
import { type StateManagerAPI } from "../state.js";

export function registerToolInterception(
  pi: ExtensionAPI,
  stateManager: StateManagerAPI,
  options: { log?: (message: string) => void } = {},
): void {
  pi.on("tool_call", async (event) => {
    const state = stateManager.getState();
    if (!state || state.status !== "running") return;

    if (event.toolName !== "bash") return;

    const command = event.input?.command as string | undefined;
    if (!command) return;

    const gitShellBlock = shouldBlockGitShellCommand(command, state.finalizationPolicy);
    if (gitShellBlock) {
      options.log?.(`Blocked bash git command: ${gitShellBlock}`);
      return { block: true, reason: gitShellBlock };
    }

    const awsShellBlock = shouldBlockAwsShellCommand(command, state.config.awsCli);
    if (awsShellBlock) {
      options.log?.(`Blocked bash aws command: ${awsShellBlock}`);
      return { block: true, reason: awsShellBlock };
    }

    const commandSpec = commandSpecFromShellWords(command);
    if (!commandSpec) {
      options.log?.("Blocked bash: command must parse to executable-plus-argv");
      return { block: true, reason: "Command must parse to executable-plus-argv." };
    }

    const policy = new PolicyEngine({ repoRoot: process.cwd() });
    const decision = policy.decide({
      id: `bash:${Date.now()}`,
      actor: { kind: "tool", id: "bash" },
      runId: state.runId,
      effect: "process.exec",
      resource: commandResource(commandSpec.executable, commandSpec.argv),
      input: {
        ...commandSpec,
        allowDestructive: state.constraints.allowDestructiveOps,
        allowGitFinalization: state.finalizationPolicy.allowGitFinalization,
      },
      purpose: "intercepted bash command",
      risk: state.constraints.allowDestructiveOps ? "write" : "read",
      dataClassification: "internal",
    });
    if (decision.result !== "allow") {
      options.log?.(`Blocked bash: ${decision.reason}`);
      let suggestion = "";
      if (command.match(/\bgit\s+(add|commit)\b/) && !state.finalizationPolicy.allowGitFinalization) {
        const patchPath = stateManager.getArtifactPath(state.cycle, state.phase, "final.patch");
        suggestion = `\n\nGit finalization disabled. Patch: git diff > ${patchPath}`;
      }
      return { block: true, reason: decision.reason + suggestion };
    }
  });
}
