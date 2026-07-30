import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { getTemplate, templates } from "../templates/index.js";
import type { GameType } from "../infra/sqliteStore.js";

function isGameType(value: unknown): value is GameType {
  return typeof value === "string" && value in templates;
}

export async function registerInstanceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/instances", async () => {
    return { instances: await ctx.instances.list() };
  });

  app.post<{
    Body: { gameType?: string; name?: string; mock?: boolean; memoryMb?: number; diskGb?: number };
  }>("/api/instances", async (req, reply) => {
    const { gameType, name, mock, memoryMb, diskGb } = req.body ?? {};
    if (!isGameType(gameType)) {
      return reply.code(400).send({ error: "gameType must be one of: " + Object.keys(templates).join(", ") });
    }
    if (!name || !name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }

    const template = getTemplate(gameType);
    const resolvedMemoryMb = memoryMb ?? template.defaultMemoryMb;
    if (!Number.isFinite(resolvedMemoryMb) || resolvedMemoryMb < 512) {
      return reply.code(400).send({ error: "memoryMb must be at least 512" });
    }
    const resolvedDiskGb = diskGb ?? 0;
    if (!Number.isFinite(resolvedDiskGb) || resolvedDiskGb < 0) {
      return reply.code(400).send({ error: "diskGb must be 0 (unlimited) or greater" });
    }

    try {
      const result = await ctx.instances.create(
        gameType,
        name.trim(),
        mock ?? true,
        resolvedMemoryMb,
        resolvedDiskGb,
      );
      return reply.code(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: `failed to create instance: ${message}` });
    }
  });

  app.get<{ Params: { id: string } }>("/api/instances/:id/credentials", async (req, reply) => {
    try {
      return await ctx.instances.getCredentials(req.params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/instances/:id/start", async (req, reply) => {
    try {
      await ctx.instances.start(req.params.id);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/instances/:id/stop", async (req, reply) => {
    try {
      await ctx.instances.stop(req.params.id);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/instances/:id/restart", async (req, reply) => {
    try {
      await ctx.instances.restart(req.params.id);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/instances/:id/recreate", async (req, reply) => {
    try {
      await ctx.instances.recreate(req.params.id);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { id: string }; Body: { time: string | null } }>(
    "/api/instances/:id/schedule",
    async (req, reply) => {
      try {
        ctx.instances.setSchedule(req.params.id, req.body?.time ?? null);
        return { ok: true };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.delete<{ Params: { id: string }; Body: { removeVolumes?: boolean } }>(
    "/api/instances/:id",
    async (req, reply) => {
      try {
        await ctx.instances.delete(req.params.id, req.body?.removeVolumes ?? false);
        return { ok: true };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );
}
