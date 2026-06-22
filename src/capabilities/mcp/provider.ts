import { Type } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";

const McpInputSchema = Type.Object({
  serverId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  args: Type.Unknown(),
  allowMcpInvoke: Type.Optional(Type.Boolean()),
});

const McpOutputSchema = Type.Object({
  serverId: Type.String(),
  toolName: Type.String(),
  result: Type.Unknown(),
});

export type McpInvoker = (request: ActionRequest, signal: AbortSignal) => Promise<unknown>;

export class McpProvider implements CapabilityProvider {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly invoker?: McpInvoker,
  ) {}

  async manifest(): Promise<CapabilityManifest> {
    return {
      providerId: "mcp",
      version: "1.0.0",
      capabilities: [{
        id: "mcp.invoke",
        effect: "mcp.invoke",
        risk: "privileged",
        inputSchema: McpInputSchema,
        outputSchema: McpOutputSchema,
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
      ok: !!this.invoker,
      checkedAt: new Date().toISOString(),
      reason: this.invoker ? undefined : "No MCP invoker configured.",
    };
  }

  async invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult> {
    const broker = new CapabilityBroker(this.policy);
    return broker.invoke(request, async () => {
      if (!this.invoker) throw new Error("No MCP invoker configured.");
      return await this.invoker(request, signal);
    }, { signal, outputSchema: McpOutputSchema });
  }
}
