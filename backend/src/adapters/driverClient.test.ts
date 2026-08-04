import { describe, expect, it } from "vitest";
import { DriverProtocolError, validateRuntimeManifest } from "./driverClient.js";

function manifest() {
  return {
    contractVersion: "1.0",
    instanceId: "a".repeat(32),
    managerId: "arma3-server-manager",
    gameType: "arma3",
    displayName: "Arma 3",
    driver: { protocolVersion: "1.0", command: ["/usr/bin/python3", "/srv/manager_driver.py"] },
    capabilities: ["discover", "adopt", "lifecycle"],
    resources: {
      containers: { api: "arma3-api", frontend: "arma3-frontend" },
      volumes: ["arma3-server"],
      networks: ["arma3-net"],
      ports: { web: 38080 },
      sizeableVolumes: ["arma3-server"],
    },
    images: { api: "localhost/api:release", frontend: "localhost/frontend:release" },
    config: { managerPath: "/srv/config/manager.toml" },
    secrets: [{ id: "manager-secrets", provider: "podman", reference: "arma3-manager-secrets" }],
    health: { type: "containers" },
    controllerRevision: 0,
  };
}

describe("runtime contract validation", () => {
  it("accepts a complete manifest containing only secret references", () => {
    expect(validateRuntimeManifest(manifest()).instanceId).toBe("a".repeat(32));
  });

  it("rejects secret-bearing fields even when nested", () => {
    const invalid = { ...manifest(), config: { password: "must-not-leak" } };
    expect(() => validateRuntimeManifest(invalid)).toThrowError(DriverProtocolError);
  });

  it("rejects generic secret fields outside the references collection", () => {
    const invalid = { ...manifest(), config: { session_secret: "must-not-leak" } };
    expect(() => validateRuntimeManifest(invalid)).toThrowError(DriverProtocolError);
  });

  it("rejects partial container topology", () => {
    const invalid = manifest();
    invalid.resources.containers = { api: "arma3-api" } as typeof invalid.resources.containers;
    expect(() => validateRuntimeManifest(invalid)).toThrow("api and frontend container roles are required");
  });

  it("rejects unsupported contract versions", () => {
    expect(() => validateRuntimeManifest({ ...manifest(), contractVersion: "2.0" })).toThrow("unsupported contractVersion");
  });

  it("rejects invalid port ranges", () => {
    const invalid = manifest();
    invalid.resources.ports.web = 70_000;
    expect(() => validateRuntimeManifest(invalid)).toThrow("ports.web and all ports must be integers from 1 through 65535");
  });

  it("rejects secret values disguised as secret references", () => {
    const invalid = manifest();
    invalid.secrets = [{ id: "manager-secrets", provider: "file" as "podman", reference: "/tmp/private" }];
    expect(() => validateRuntimeManifest(invalid)).toThrow("Podman references only");
  });
});
