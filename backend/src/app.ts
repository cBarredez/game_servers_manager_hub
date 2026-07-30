import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { AppConfig } from "./config/index.js";
import type { SqliteStore } from "./infra/sqliteStore.js";
import type { InstanceManager } from "./domain/instanceManager.js";
import type { MaintenanceService } from "./domain/maintenanceService.js";
import { registerAuthRoutes, requireAuth } from "./routes/auth.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerInstanceRoutes } from "./routes/instances.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";

export interface AppContext {
  config: AppConfig;
  store: SqliteStore;
  instances: InstanceManager;
  maintenance: MaintenanceService;
  /** Git commit of the hub's own source tree, resolved once at startup (server.ts) — the hub runs straight from source, not a discrete build artifact, so there's no separate build date to show. */
  version: { commit: string };
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cookie);

  app.get("/api/health", async () => ({ status: "ok", commit: ctx.version.commit }));

  await registerAuthRoutes(app, ctx);

  await app.register(
    async (protectedApp) => {
      protectedApp.addHook("onRequest", requireAuth(ctx));
      await registerTemplateRoutes(protectedApp, ctx);
      await registerInstanceRoutes(protectedApp, ctx);
      await registerMaintenanceRoutes(protectedApp, ctx);
    },
    { prefix: "/" },
  );

  return app;
}
