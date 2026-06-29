import type { PolicyDecision, PolicyEngine, ActionRequest } from "../policy/engine.js";
import { parseWithSchema } from "../domain/validate.js";

export interface ActionResult<T = unknown> {
  requestId: string;
  decision: PolicyDecision;
  ok: boolean;
  output?: T;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export type ActionHandler<T = unknown> = (request: ActionRequest, signal?: AbortSignal) => Promise<T>;

export interface ActionInvocationOptions {
  signal?: AbortSignal;
  outputSchema?: object;
  transformOutput?: <T>(output: T, request: ActionRequest) => T;
}

export class CapabilityBroker {
  constructor(private readonly policy: PolicyEngine) {}

  async invoke<T>(
    request: ActionRequest,
    handler: ActionHandler<T>,
    signalOrOptions?: AbortSignal | ActionInvocationOptions,
  ): Promise<ActionResult<T>> {
    const options = isAbortSignal(signalOrOptions)
      ? { signal: signalOrOptions }
      : signalOrOptions ?? {};
    const startedAt = new Date().toISOString();
    const decision = this.policy.decide(request);
    if (decision.result !== "allow") {
      return {
        requestId: request.id,
        decision,
        ok: false,
        error: decision.reason,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    try {
      const output = await handler(request, options.signal);
      const validatedOutput = options.outputSchema
        ? parseWithSchema<T>(options.outputSchema, output, `Capability output for ${request.effect}`)
        : output;
      const transformedOutput = options.transformOutput
        ? options.transformOutput<T>(validatedOutput, request)
        : validatedOutput;
      return {
        requestId: request.id,
        decision,
        ok: true,
        output: transformedOutput,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        requestId: request.id,
        decision,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && "aborted" in value && "addEventListener" in value;
}
