import type { CapabilityManifest, CapabilityProvider } from "./manifest.js";
import { validateCapabilityManifest } from "./manifest.js";

export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityProvider>();
  private readonly manifests = new Map<string, CapabilityManifest>();

  async register(provider: CapabilityProvider): Promise<CapabilityManifest> {
    const manifest = validateCapabilityManifest(await provider.manifest());
    if (this.providers.has(manifest.providerId)) {
      throw new Error(`Capability provider already registered: ${manifest.providerId}`);
    }
    this.providers.set(manifest.providerId, provider);
    this.manifests.set(manifest.providerId, manifest);
    return manifest;
  }

  getProvider(providerId: string): CapabilityProvider | undefined {
    return this.providers.get(providerId);
  }

  getManifest(providerId: string): CapabilityManifest | undefined {
    return this.manifests.get(providerId);
  }

  listManifests(): CapabilityManifest[] {
    return [...this.manifests.values()];
  }
}
