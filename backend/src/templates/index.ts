import type { GameType } from "../infra/sqliteStore.js";
import type { GameTemplate } from "./types.js";
import { arma3Template } from "./arma3.js";
import { pzTemplate } from "./pz.js";

export const templates: Record<GameType, GameTemplate> = {
  arma3: arma3Template,
  pz: pzTemplate,
};

export function getTemplate(gameType: GameType): GameTemplate {
  const template = templates[gameType];
  if (!template) throw new Error(`unknown game type: ${gameType}`);
  return template;
}

export function listTemplates(): GameTemplate[] {
  return Object.values(templates);
}

export type { GameTemplate, PortMap, InstanceContext, GeneratedSecrets } from "./types.js";
