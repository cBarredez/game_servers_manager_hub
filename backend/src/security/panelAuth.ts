import type { SqliteStore } from "../infra/sqliteStore.js";
import type { AppConfig } from "../config/index.js";
import { hashPassword } from "./passwordHasher.js";

const PANEL_AUTH_KEY = "panel-auth";

export interface PanelAuth {
  username: string;
  passwordHash: string;
}

/** Lazily seeds panel credentials from config on first run. */
export function getOrSeedPanelAuth(store: SqliteStore, config: AppConfig): PanelAuth {
  const existing = store.getJson<PanelAuth>(PANEL_AUTH_KEY);
  if (existing) return existing;

  const seeded: PanelAuth = {
    username: config.web.username,
    passwordHash: hashPassword(config.web.password),
  };
  store.setJson(PANEL_AUTH_KEY, seeded);
  return seeded;
}
