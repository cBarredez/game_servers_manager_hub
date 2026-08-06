import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import type { AppConfig } from "./config/index.js";
import type { SqliteStore } from "./infra/sqliteStore.js";
import type { InstanceManager } from "./domain/instanceManager.js";
import type { MaintenanceService } from "./domain/maintenanceService.js";
import type { HubDeploymentService } from "./domain/deploymentService.js";
import { registerAuthRoutes, requireAuth } from "./routes/auth.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerInstanceRoutes } from "./routes/instances.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";

export interface AppContext {
  config: AppConfig;
  store: SqliteStore;
  instances: InstanceManager;
  maintenance: MaintenanceService;
  deployment: HubDeploymentService;
  version: { commit: string; buildDate: string | null; deploymentMode: "external" };
  /** Built frontend (frontend/dist) — served directly by this same process so `npm start` is self-sufficient, no separate static server needed. */
  frontendDistDir: string;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cookie);
  // Public like the login page itself has to be — the SPA's own JS is what
  // performs the authenticated /api/* calls, so it must load before login.
  await app.register(staticPlugin, { root: ctx.frontendDistDir });

  app.get("/api/health", async () => ({ status: "ok", ...ctx.version }));

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
