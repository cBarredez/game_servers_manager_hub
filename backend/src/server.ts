import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { SqliteStore } from "./infra/sqliteStore.js";
import { PortAllocator } from "./infra/portAllocator.js";
import { startMaintenanceScheduler } from "./infra/scheduler.js";
import { getHeadCommit } from "./infra/git.js";
import { InstanceManager } from "./domain/instanceManager.js";
import { MaintenanceService } from "./domain/maintenanceService.js";
import { HubDeploymentService } from "./domain/deploymentService.js";
import { buildApp, type AppContext } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(__dirname, "../..");

async function main(): Promise<void> {
  const configDir = process.env.HUB_CONFIG_DIR ?? path.join(HUB_ROOT, "config");
  const configFile = process.env.HUB_CONFIG_FILE ?? path.join(configDir, "manager.toml");
  const secretsFile = process.env.HUB_SECRETS_FILE ?? path.join(configDir, "manager.secrets.toml");
  const config = await loadConfig(configFile, secretsFile);

  const dataDir = process.env.HUB_DATA_DIR ?? path.join(HUB_ROOT, "data");
  const reposRoot = process.env.HUB_REPOS_DIR
    ? path.resolve(process.env.HUB_REPOS_DIR)
    : path.resolve(HUB_ROOT, config.podman.reposDir);

  const store = new SqliteStore(path.join(dataDir, "hub.sqlite3"));
  const allocator = new PortAllocator(store, config.ports.webBase);
  const instances = new InstanceManager(store, allocator, reposRoot, dataDir);
  const maintenance = new MaintenanceService(store, instances);
  const commit = process.env.HUB_COMMIT ?? (await getHeadCommit(HUB_ROOT)) ?? "unknown";
  const buildDate = process.env.HUB_BUILD_DATE ?? null;
  const deployment = new HubDeploymentService(commit, buildDate);
  const version = { commit, buildDate, deploymentMode: "external" as const };

  const frontendDistDir = path.join(HUB_ROOT, "frontend", "dist");
  const ctx: AppContext = { config, store, instances, maintenance, deployment, version, frontendDistDir };
  const app = await buildApp(ctx);

  await instances.reconcileClaims();
  startMaintenanceScheduler(maintenance);

  await app.listen({ port: config.web.port, host: config.web.bindIp });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
