import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { SqliteStore } from "./infra/sqliteStore.js";
import { PortAllocator } from "./infra/portAllocator.js";
import { startMaintenanceScheduler } from "./infra/scheduler.js";
import { getHeadCommit } from "./infra/git.js";
import { InstanceManager } from "./domain/instanceManager.js";
import { MaintenanceService } from "./domain/maintenanceService.js";
import { SelfUpdateService } from "./domain/selfUpdateService.js";
import { buildApp, type AppContext } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(__dirname, "../..");

async function main(): Promise<void> {
  const configDir = process.env.HUB_CONFIG_DIR ?? path.join(HUB_ROOT, "config");
  const config = await loadConfig(path.join(configDir, "manager.toml"), path.join(configDir, "manager.secrets.toml"));

  const dataDir = process.env.HUB_DATA_DIR ?? path.join(HUB_ROOT, "data");
  const reposRoot = path.resolve(HUB_ROOT, config.podman.reposDir);

  const store = new SqliteStore(path.join(dataDir, "hub.sqlite3"));
  const allocator = new PortAllocator(store, config.ports.webBase);
  const instances = new InstanceManager(store, allocator, reposRoot, dataDir);
  const maintenance = new MaintenanceService(store, instances);
  const selfUpdate = new SelfUpdateService(store, HUB_ROOT);
  const version = { commit: (await getHeadCommit(HUB_ROOT)) ?? "unknown" };

  const frontendDistDir = path.join(HUB_ROOT, "frontend", "dist");
  const ctx: AppContext = { config, store, instances, maintenance, selfUpdate, version, frontendDistDir };
  const app = await buildApp(ctx);

  await instances.reconcileClaims();
  startMaintenanceScheduler(maintenance);

  await app.listen({ port: config.web.port, host: config.web.bindIp });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
