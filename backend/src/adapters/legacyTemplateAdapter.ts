import type { GameType } from "../infra/sqliteStore.js";
import type { GameTemplate } from "../templates/types.js";

/**
 * Compatibility boundary for hub-created instances that predate Contract v1.
 * It deliberately exposes no discovery/claim operation: template-derived
 * names remain valid only for rows already owned/provisioned by this hub.
 */
export class LegacyTemplateAdapter {
  readonly managerId: string;
  readonly supportsAdoption = false;

  constructor(readonly template: GameTemplate) {
    this.managerId = `legacy-template-${template.gameType}`;
  }

  get gameType(): GameType {
    return this.template.gameType;
  }
}
