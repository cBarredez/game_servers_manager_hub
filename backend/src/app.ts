import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { AppConfig } from "./config/index.js";
import type { SqliteStore } from "./infra/sqliteStore.js";
import type { InstanceManager } from "./domain/instanceManager.js";
import { registerAuthRoutes, requireAuth } from "./routes/auth.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerInstanceRoutes } from "./routes/instances.js";

export interface AppContext {
  config: AppConfig;
  store: SqliteStore;
  instances: InstanceManager;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cookie);

  app.get("/api/health", async () => ({ status: "ok" }));

  await registerAuthRoutes(app, ctx);

  await app.register(
    async (protectedApp) => {
      protectedApp.addHook("onRequest", requireAuth(ctx));
      await registerTemplateRoutes(protectedApp, ctx);
      await registerInstanceRoutes(protectedApp, ctx);
    },
    { prefix: "/" },
  );

  return app;
}
