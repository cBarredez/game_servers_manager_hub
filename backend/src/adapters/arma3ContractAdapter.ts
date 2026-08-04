import type { DiscoveryCandidate, GameAdapter, RuntimeInstanceManifest } from "./types.js";
import { claimDriver, discoverArma3, lifecycleDriver, releaseDriver } from "./driverClient.js";

export class Arma3ContractAdapter implements GameAdapter {
  readonly managerId = "arma3-server-manager";
  readonly gameType = "arma3";

  discover(): Promise<DiscoveryCandidate[]> {
    return discoverArma3();
  }

  claim(candidate: DiscoveryCandidate, controllerId: string) {
    return claimDriver(candidate.manifest, controllerId);
  }

  release(manifest: RuntimeInstanceManifest, controllerId: string, revision: number): Promise<void> {
    return releaseDriver(manifest, controllerId, revision);
  }

  lifecycle(
    manifest: RuntimeInstanceManifest,
    controllerId: string,
    revision: number,
    action: "start" | "stop" | "restart",
  ): Promise<void> {
    return lifecycleDriver(manifest, controllerId, revision, action);
  }
}
