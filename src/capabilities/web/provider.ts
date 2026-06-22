import * as crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { Type, type Static } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import { parseWithSchema } from "../../domain/validate.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";

const WebFetchInputSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  maxBytes: Type.Optional(Type.Number({ minimum: 1 })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
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
      await assertPublicDns(input.url);
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 30_000);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      const response = await fetch(input.url, { signal: combinedSignal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Redirect blocked for governed fetch.");
      }
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

async function assertPublicDns(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`DNS resolved to private or metadata-like address: ${record.address}`);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return true;
  if (value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  if (value === "169.254.169.254" || value === "0.0.0.0") return true;
  if (/^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)) return true;
  const match172 = value.match(/^172\.(\d+)\./);
  return !!match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31;
}
