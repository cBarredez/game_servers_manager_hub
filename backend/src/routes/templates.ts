import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { listTemplates } from "../templates/index.js";

export async function registerTemplateRoutes(app: FastifyInstance, _ctx: AppContext): Promise<void> {
  app.get("/api/templates", async () => ({
    templates: listTemplates().map((t) => ({
      gameType: t.gameType,
      displayName: t.displayName,
      defaultMemoryMb: t.defaultMemoryMb,
    })),
  }));
}
