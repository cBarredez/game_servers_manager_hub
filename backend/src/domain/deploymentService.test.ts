import { describe, expect, it } from "vitest";
import { HubDeploymentService } from "./deploymentService.js";

describe("HubDeploymentService", () => {
  it("reports immutable external deployment metadata", () => {
    expect(new HubDeploymentService("abc123", "2026-08-04T12:00:00Z").getStatus()).toEqual({
      currentCommit: "abc123",
      buildDate: "2026-08-04T12:00:00Z",
      deploymentMode: "external",
      updateAvailable: null,
      message: "Hub updates are managed externally with deploy.py.",
    });
  });
});
