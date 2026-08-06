import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app.js";
import { HubDeploymentService } from "../domain/deploymentService.js";
import { registerMaintenanceRoutes } from "./maintenance.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithExternalDeployment() {
  const app = Fastify();
  apps.push(app);
  const ctx = {
    deployment: new HubDeploymentService("abc123", "2026-08-04T00:00:00Z"),
  } as AppContext;
  await registerMaintenanceRoutes(app, ctx);
  return app;
}

describe("external hub deployment routes", () => {
  it("reports immutable external deployment metadata", async () => {
    const app = await appWithExternalDeployment();
    const response = await app.inject({ method: "GET", url: "/api/maintenance/hub-status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currentCommit: "abc123",
      buildDate: "2026-08-04T00:00:00Z",
      deploymentMode: "external",
      updateAvailable: null,
    });
  });

  it("keeps the former update route as an explicit conflict", async () => {
    const app = await appWithExternalDeployment();
    const response = await app.inject({ method: "POST", url: "/api/maintenance/hub/update" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "external_deployment_required",
      message: "Hub updates are managed externally with deploy.py.",
    });
  });
});
