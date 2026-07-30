import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { SqliteStore } from "./infra/sqliteStore.js";
import { PortAllocator } from "./infra/portAllocator.js";
import { InstanceManager } from "./domain/instanceManager.js";
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

  const ctx: AppContext = { config, store, instances };
  const app = await buildApp(ctx);

  await app.listen({ port: config.web.port, host: config.web.bindIp });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
