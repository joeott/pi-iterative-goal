import type { PolicyDecision, PolicyEngine, ActionRequest } from "../policy/engine.js";

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

export class CapabilityBroker {
  constructor(private readonly policy: PolicyEngine) {}

  async invoke<T>(request: ActionRequest, handler: ActionHandler<T>, signal?: AbortSignal): Promise<ActionResult<T>> {
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
      const output = await handler(request, signal);
      return {
        requestId: request.id,
        decision,
        ok: true,
        output,
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
