import { Type } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";
import { providerUnavailable } from "../unavailable.js";

const VisionInputSchema = Type.Object({
  assetIds: Type.Array(Type.String()),
  task: Type.String({ minLength: 1 }),
  outputSchema: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

const VisionOutputSchema = Type.Object({
  assetIds: Type.Array(Type.String()),
  task: Type.String(),
  observations: Type.Array(Type.Unknown()),
});

export type VisionBackend = (request: ActionRequest, signal: AbortSignal) => Promise<unknown>;

export class VisionProvider implements CapabilityProvider {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly backend?: VisionBackend,
  ) {}

  async manifest(): Promise<CapabilityManifest> {
    return {
      providerId: "vision",
      version: "1.0.0",
      capabilities: [{
        id: "vision.inspect",
        effect: "vision.inspect",
        risk: "read",
        inputSchema: VisionInputSchema,
        outputSchema: VisionOutputSchema,
        networkAccess: "none",
        credentialRequirements: [],
        idempotent: true,
        concurrencySafe: true,
        outputSensitivity: "internal",
      }],
    };
  }

  async preflight(_ctx: ProviderContext): Promise<ProviderHealth> {
    return {
      ok: !!this.backend,
      checkedAt: new Date().toISOString(),
      reason: this.backend ? undefined : "No vision backend configured.",
    };
  }

  async invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult> {
    if (!this.backend) return providerUnavailable(request.id, "vision", "No vision backend configured.");
    const backend = this.backend;
    const broker = new CapabilityBroker(this.policy);
    return broker.invoke(request, async () => {
      return await backend(request, signal);
    }, { signal, outputSchema: VisionOutputSchema });
  }
}
