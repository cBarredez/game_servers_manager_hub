import type { GameType } from "../infra/sqliteStore.js";

export type DiscoveryStatus = "ready" | "incompatible" | "partial" | "conflict" | "already-claimed";

export interface RuntimeInstanceManifest {
  contractVersion: "1.0";
  instanceId: string;
  managerId: string;
  gameType: GameType;
  displayName: string;
  driver: { protocolVersion: "1.0"; command: string[] };
  capabilities: string[];
  resources: {
    containers: Record<string, string> & { api: string; frontend: string };
    volumes: string[];
    networks: string[];
    ports: Record<string, number>;
    primaryMetricsContainer?: string;
    sizeableVolumes?: string[];
  };
  images: Record<string, string>;
  config: Record<string, unknown>;
  secrets: { id: string; provider: "podman"; reference: string }[];
  health: Record<string, unknown>;
  controllerRevision: number;
  updatedAt?: string;
}

export interface DiscoveryCandidate {
  candidateId: string;
  instanceId: string;
  managerId: string;
  gameType: GameType;
  displayName: string;
  status: DiscoveryStatus;
  issues: string[];
  controller: { controllerId: string; revision: number; claimedAt: string } | null;
  manifest: RuntimeInstanceManifest;
}

export interface DriverClaim {
  claimed: true;
  controller: { controllerId: string; revision: number; claimedAt: string };
  manifest: RuntimeInstanceManifest;
}

export interface GameAdapter {
  readonly managerId: string;
  readonly gameType: GameType;
  discover(): Promise<DiscoveryCandidate[]>;
  claim(candidate: DiscoveryCandidate, controllerId: string): Promise<DriverClaim>;
  release(manifest: RuntimeInstanceManifest, controllerId: string, revision: number): Promise<void>;
  lifecycle(manifest: RuntimeInstanceManifest, controllerId: string, revision: number, action: "start" | "stop" | "restart"): Promise<void>;
}
