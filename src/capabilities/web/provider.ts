import * as crypto from "node:crypto";
import { Type, type Static } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import { parseWithSchema } from "../../domain/validate.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";

const WebFetchInputSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  maxBytes: Type.Optional(Type.Number({ minimum: 1 })),
});

const WebFetchOutputSchema = Type.Object({
  url: Type.String(),
  status: Type.Number(),
  mimeType: Type.String(),
  fetchedAt: Type.String(),
  contentHash: Type.String(),
  body: Type.String(),
  truncated: Type.Boolean(),
});

type WebFetchInput = Static<typeof WebFetchInputSchema>;

export class WebFetchProvider implements CapabilityProvider {
  constructor(private readonly policy: PolicyEngine) {}

  async manifest(): Promise<CapabilityManifest> {
    return {
      providerId: "web",
      version: "1.0.0",
      capabilities: [{
        id: "web.fetch",
        effect: "network.fetch",
        risk: "read",
        inputSchema: WebFetchInputSchema,
        outputSchema: WebFetchOutputSchema,
        networkAccess: "allowlisted",
        credentialRequirements: [],
        idempotent: true,
        concurrencySafe: true,
        outputSensitivity: "public",
      }],
    };
  }

  async preflight(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: typeof fetch === "function", checkedAt: new Date().toISOString(), reason: typeof fetch === "function" ? undefined : "global fetch unavailable" };
  }

  async invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult> {
    const broker = new CapabilityBroker(this.policy);
    return broker.invoke(request, async () => {
      const input = parseWithSchema<WebFetchInput>(WebFetchInputSchema, request.input, "Web fetch input");
      const response = await fetch(input.url, { signal });
      const mimeType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      const maxBytes = input.maxBytes ?? 1_000_000;
      const bytes = Buffer.from(text);
      const truncated = bytes.byteLength > maxBytes;
      const body = truncated ? bytes.subarray(0, maxBytes).toString("utf8") : text;
      return {
        url: response.url || input.url,
        status: response.status,
        mimeType,
        fetchedAt: new Date().toISOString(),
        contentHash: crypto.createHash("sha256").update(text).digest("hex"),
        body,
        truncated,
      };
    }, { signal, outputSchema: WebFetchOutputSchema });
  }
}
