import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { templates } from "../templates/index.js";
import type { GameType } from "../infra/sqliteStore.js";
import type { MaintenanceSettings } from "../domain/maintenanceService.js";

function isGameType(value: unknown): value is GameType {
  return typeof value === "string" && value in templates;
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function registerMaintenanceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/maintenance/settings", async () => ctx.maintenance.getSettings());

  app.put<{ Body: Partial<MaintenanceSettings> }>("/api/maintenance/settings", async (req, reply) => {
    const body = req.body ?? {};
    if (body.cleanupTime !== undefined && !isValidTime(body.cleanupTime)) {
      return reply.code(400).send({ error: "cleanupTime must be \"HH:MM\"" });
    }
    if (body.maxCrashRestarts !== undefined && (!Number.isInteger(body.maxCrashRestarts) || body.maxCrashRestarts < 1)) {
      return reply.code(400).send({ error: "maxCrashRestarts must be a positive integer" });
    }
    return ctx.maintenance.updateSettings(body);
  });

  app.get<{ Querystring: { limit?: string } }>("/api/maintenance/log", async (req) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? "50", 10) || 50, 1), 200);
    return { entries: ctx.store.listMaintenanceLog(limit) };
  });

  app.get("/api/maintenance/image-status", async () => {
    return { games: await ctx.instances.imageStatus() };
  });

  app.post<{ Params: { gameType: string } }>("/api/maintenance/images/:gameType/rebuild", async (req, reply) => {
    const { gameType } = req.params;
    if (!isGameType(gameType)) {
      return reply.code(400).send({ error: "gameType must be one of: " + Object.keys(templates).join(", ") });
    }
    try {
      return await ctx.instances.rebuildImages(gameType);
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { gameType: string } }>("/api/maintenance/images/:gameType/pull", async (req, reply) => {
    const { gameType } = req.params;
    if (!isGameType(gameType)) {
      return reply.code(400).send({ error: "gameType must be one of: " + Object.keys(templates).join(", ") });
    }
    try {
      const result = await ctx.instances.pullLatest(gameType);
      return reply.code(result.success ? 200 : 409).send(result);
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/maintenance/hub-status", async () => ctx.selfUpdate.getStatus());

  app.post("/api/maintenance/hub/update", async (req, reply) => {
    try {
      const result = await ctx.selfUpdate.update();
      if (!result.success) {
        return reply.code(409).send(result);
      }
      if (result.restarting) {
        // Only hand off to the new process once this response has actually
        // reached the client — closing the server any earlier would drop it.
        reply.raw.once("finish", () => {
          void ctx.selfUpdate.restart(app);
        });
      }
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
