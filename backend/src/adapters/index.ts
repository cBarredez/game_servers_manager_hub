import { Arma3ContractAdapter } from "./arma3ContractAdapter.js";
import { LegacyTemplateAdapter } from "./legacyTemplateAdapter.js";
import type { GameAdapter } from "./types.js";
import type { GameType } from "../infra/sqliteStore.js";
import { listTemplates } from "../templates/index.js";

const adapters: GameAdapter[] = [new Arma3ContractAdapter()];
const legacyAdapters = listTemplates().map((template) => new LegacyTemplateAdapter(template));

export function listContractAdapters(): GameAdapter[] {
  return adapters;
}

export function getContractAdapter(managerId: string): GameAdapter {
  const adapter = adapters.find((candidate) => candidate.managerId === managerId);
  if (!adapter) throw new Error(`no contract adapter registered for manager: ${managerId}`);
  return adapter;
}

export function listLegacyTemplateAdapters(): LegacyTemplateAdapter[] {
  return legacyAdapters;
}

export function getLegacyTemplateAdapter(gameType: GameType): LegacyTemplateAdapter {
  const adapter = legacyAdapters.find((candidate) => candidate.gameType === gameType);
  if (!adapter) throw new Error(`no legacy template adapter registered for game: ${gameType}`);
  return adapter;
}

export type { DiscoveryCandidate, DiscoveryStatus, RuntimeInstanceManifest, GameAdapter } from "./types.js";
export { LegacyTemplateAdapter } from "./legacyTemplateAdapter.js";
