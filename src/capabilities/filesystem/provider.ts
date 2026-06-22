import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { CapabilityBroker, type ActionResult } from "../broker.js";
import type { CapabilityManifest, CapabilityProvider, ProviderContext, ProviderHealth } from "../manifest.js";
import { resolveContainedPath } from "../../domain/path-scope.js";
import type { ActionRequest, PolicyEngine } from "../../policy/engine.js";

const ReadOutputSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const WriteOutputSchema = Type.Object({
  path: Type.String(),
  bytesWritten: Type.Number(),
});

const DeleteOutputSchema = Type.Object({
  path: Type.String(),
  deleted: Type.Boolean(),
});

export class FileSystemProvider implements CapabilityProvider {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly repoRoot: string,
  ) {}

  async manifest(): Promise<CapabilityManifest> {
    return {
      providerId: "filesystem",
      version: "1.0.0",
      capabilities: [
        {
          id: "filesystem.read",
          effect: "fs.read",
          risk: "read",
          inputSchema: Type.Object({ path: Type.String() }),
          outputSchema: ReadOutputSchema,
          networkAccess: "none",
          credentialRequirements: [],
          idempotent: true,
          concurrencySafe: true,
          outputSensitivity: "internal",
        },
        {
          id: "filesystem.write",
          effect: "fs.write",
          risk: "write",
          inputSchema: Type.Object({ path: Type.String(), content: Type.String() }),
          outputSchema: WriteOutputSchema,
          networkAccess: "none",
          credentialRequirements: [],
          idempotent: false,
          concurrencySafe: false,
          outputSensitivity: "internal",
        },
        {
          id: "filesystem.delete",
          effect: "fs.delete",
          risk: "write",
          inputSchema: Type.Object({ path: Type.String() }),
          outputSchema: DeleteOutputSchema,
          networkAccess: "none",
          credentialRequirements: [],
          idempotent: false,
          concurrencySafe: false,
          outputSensitivity: "internal",
        },
      ],
    };
  }

  async preflight(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  async invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionResult> {
    const broker = new CapabilityBroker(this.policy);
    const outputSchema = request.effect === "fs.read"
      ? ReadOutputSchema
      : request.effect === "fs.write"
        ? WriteOutputSchema
        : DeleteOutputSchema;

    return broker.invoke(request, async () => {
      if (signal.aborted) throw new Error("Filesystem action aborted.");
      const resolved = resolveContainedPath(this.repoRoot, request.resource.value);

      if (request.effect === "fs.read") {
        return {
          path: request.resource.value,
          content: await fs.readFile(resolved, "utf8"),
        };
      }

      if (request.effect === "fs.write") {
        const input = request.input as Record<string, unknown>;
        const content = typeof input.content === "string" ? input.content : "";
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
        return { path: request.resource.value, bytesWritten: Buffer.byteLength(content) };
      }

      if (request.effect === "fs.delete") {
        await fs.rm(resolved, { force: true });
        return { path: request.resource.value, deleted: true };
      }

      throw new Error(`Unsupported filesystem effect: ${request.effect}`);
    }, { signal, outputSchema });
  }
}
