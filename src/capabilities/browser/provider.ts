import { Type } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";

const BrowserInputSchema = Type.Object({
  action: Type.String({ minLength: 1 }),
  url: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  allowBrowserInteraction: Type.Optional(Type.Boolean()),
});

const BrowserOutputSchema = Type.Object({
  action: Type.String(),
  ok: Type.Boolean(),
  message: Type.String(),
});

export type BrowserBackend = (request: ActionRequest, signal: AbortSignal) => Promise<unknown>;

export class BrowserProvider implements CapabilityProvider {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly backend?: BrowserBackend,
  ) {}

  async manifest(): Promise<CapabilityManifest> {
    return {
      providerId: "browser",
      version: "1.0.0",
      capabilities: [{
        id: "browser.interact",
        effect: "browser.interact",
        risk: "privileged",
        inputSchema: BrowserInputSchema,
        outputSchema: BrowserOutputSchema,
        networkAccess: "allowlisted",
        credentialRequirements: [],
        idempotent: false,
        concurrencySafe: false,
        outputSensitivity: "internal",
      }],
    };
  }

  async preflight(_ctx: ProviderContext): Promise<ProviderHealth> {
    return {
      ok: !!this.backend,
      checkedAt: new Date().toISOString(),
      reason: this.backend ? undefined : "No browser backend configured.",
    };
  }

  async invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult> {
    if (!this.backend) return providerUnavailable(request.id, "No browser backend configured.");
    const backend = this.backend;
    const broker = new CapabilityBroker(this.policy);
    return broker.invoke(request, async () => {
      return await backend(request, signal);
    }, { signal, outputSchema: BrowserOutputSchema });
  }
}

function providerUnavailable(requestId: string, reason: string): ActionResult {
  const now = new Date().toISOString();
  return {
    requestId,
    ok: false,
    error: reason,
    startedAt: now,
    finishedAt: now,
    decision: {
      result: "deny",
      ruleIds: ["provider.browser.unavailable"],
      reason,
    },
  };
}
