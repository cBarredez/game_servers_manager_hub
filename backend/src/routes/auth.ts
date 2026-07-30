import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { verifyPassword } from "../security/passwordHasher.js";
import { createSessionProof, verifySessionProof } from "../security/sessionProof.js";
import { getOrSeedPanelAuth } from "../security/panelAuth.js";

export const SESSION_COOKIE = "hub_session";

declare module "fastify" {
  interface FastifyRequest {
    hubUser?: string;
  }
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: "username and password are required" });
    }

    const auth = getOrSeedPanelAuth(ctx.store, ctx.config);
    if (username !== auth.username || !verifyPassword(password, auth.passwordHash)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const token = createSessionProof(auth.username, ctx.config.web.sessionSecret);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return { authenticated: true, username: auth.username };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { authenticated: false };
  });

  app.get("/api/auth/check", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    const result = verifySessionProof(token, ctx.config.web.sessionSecret);
    return result.valid ? { authenticated: true, username: result.username } : { authenticated: false };
  });
}

/** Fastify onRequest hook: rejects unauthenticated requests to a protected group. */
export function requireAuth(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const result = verifySessionProof(token, ctx.config.web.sessionSecret);
    if (!result.valid) {
      reply.code(401).send({ error: "authentication required" });
      return;
    }
    req.hubUser = result.username;
  };
}
