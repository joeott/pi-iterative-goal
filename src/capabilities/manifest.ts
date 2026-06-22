import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { parseWithSchema } from "../domain/validate.js";
import type { ActionRequest, Effect } from "../policy/engine.js";
import type { ActionResult } from "./broker.js";

export type CapabilityRisk = "read" | "write" | "privileged";
export type OutputSensitivity = "public" | "internal" | "secret";

export const EffectValues = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "process.exec",
  "network.fetch",
  "browser.interact",
  "vision.inspect",
  "mcp.invoke",
  "git.branch",
  "git.stage",
  "git.commit",
  "git.push",
  "git.pr.open",
  "cloud.read",
  "cloud.mutate",
  "secret.read",
  "package.install",
  "ci.read",
  "ci.trigger",
] as const;

export const CapabilityDeclarationSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  effect: StringEnum([...EffectValues] as const),
  risk: StringEnum(["read", "write", "privileged"] as const),
  inputSchema: Type.Object({}, { additionalProperties: true }),
  outputSchema: Type.Object({}, { additionalProperties: true }),
  networkAccess: StringEnum(["none", "allowlisted", "unrestricted"] as const),
  credentialRequirements: Type.Array(Type.String()),
  idempotent: Type.Boolean(),
  concurrencySafe: Type.Boolean(),
  outputSensitivity: StringEnum(["public", "internal", "secret"] as const),
});

export const CapabilityManifestSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  capabilities: Type.Array(CapabilityDeclarationSchema),
});

export interface CapabilityDeclaration {
  id: string;
  effect: Effect;
  risk: CapabilityRisk;
  inputSchema: object;
  outputSchema: object;
  networkAccess: "none" | "allowlisted" | "unrestricted";
  credentialRequirements: string[];
  idempotent: boolean;
  concurrencySafe: boolean;
  outputSensitivity: OutputSensitivity;
}

export interface CapabilityManifest {
  providerId: string;
  version: string;
  capabilities: CapabilityDeclaration[];
}

export type ParsedCapabilityManifest = Static<typeof CapabilityManifestSchema>;

export function validateCapabilityManifest(manifest: unknown): CapabilityManifest {
  const parsed = parseWithSchema<ParsedCapabilityManifest>(CapabilityManifestSchema, manifest, "Capability manifest");
  const ids = new Set<string>();
  for (const capability of parsed.capabilities) {
    if (ids.has(capability.id)) {
      throw new Error(`Capability manifest has duplicate capability id: ${capability.id}`);
    }
    ids.add(capability.id);
    if (capability.effect === "network.fetch" && capability.networkAccess === "none") {
      throw new Error(`Capability ${capability.id} declares network.fetch with networkAccess=none.`);
    }
    if (capability.outputSensitivity === "secret" && capability.risk === "read") {
      throw new Error(`Capability ${capability.id} produces secret output but declares read-only risk.`);
    }
  }
  return parsed as CapabilityManifest;
}

export interface ProviderContext {
  runId: string;
  cwd: string;
}

export interface ProviderHealth {
  ok: boolean;
  checkedAt: string;
  reason?: string;
}

export interface CapabilityProvider {
  manifest(): Promise<CapabilityManifest>;
  preflight(ctx: ProviderContext): Promise<ProviderHealth>;
  invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult>;
}
