import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import { parseWithSchema } from "../../domain/validate.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";

const ProcessInputSchema = Type.Object({
  executable: Type.String({ minLength: 1 }),
  argv: Type.Array(Type.String()),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  allowDestructive: Type.Optional(Type.Boolean()),
  allowGitFinalization: Type.Optional(Type.Boolean()),
});

const ProcessOutputSchema = Type.Object({
  code: Type.Union([Type.Number(), Type.Null()]),
  stdout: Type.String(),
  stderr: Type.String(),
  killed: Type.Boolean(),
});

type ProcessInput = Static<typeof ProcessInputSchema>;
type ProcessOutput = Static<typeof ProcessOutputSchema>;

export class ProcessProvider implements CapabilityProvider {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly defaultCwd: string,
  ) {}

  async manifest(): Promise<CapabilityManifest> {
    return {
      providerId: "process",
      version: "1.0.0",
      capabilities: [{
        id: "process.exec",
        effect: "process.exec",
        risk: "privileged",
        inputSchema: ProcessInputSchema,
        outputSchema: ProcessOutputSchema,
        networkAccess: "none",
        credentialRequirements: [],
        idempotent: false,
        concurrencySafe: false,
        outputSensitivity: "internal",
      }],
    };
  }

  async preflight(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  async invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult<ProcessOutput>> {
    const broker = new CapabilityBroker(this.policy);
    return broker.invoke(request, async () => {
      const input = parseWithSchema<ProcessInput>(ProcessInputSchema, request.input, "Process input");
      return await spawnExec(input, this.defaultCwd, signal);
    }, { signal, outputSchema: ProcessOutputSchema });
  }
}

function spawnExec(input: ProcessInput, defaultCwd: string, signal: AbortSignal): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Process action aborted."));
      return;
    }

    const proc = spawn(input.executable, input.argv, {
      cwd: input.cwd ?? defaultCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
    }, input.timeoutMs ?? 120_000);
    timeout.unref();

    const abort = () => {
      killed = true;
      proc.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr, killed });
    });
  });
}
