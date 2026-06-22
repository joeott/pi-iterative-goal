import type { ActionRequest, Effect } from "../policy/engine.js";
import type { ActionResult } from "./broker.js";

export type CapabilityRisk = "read" | "write" | "privileged";
export type OutputSensitivity = "public" | "internal" | "secret";

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
