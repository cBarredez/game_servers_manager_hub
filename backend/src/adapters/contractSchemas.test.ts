import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const contractsDir = path.resolve(process.cwd(), "..", "contracts", "v1");
const contractSchema = JSON.parse(
  readFileSync(path.join(contractsDir, "server-manager-contract.schema.json"), "utf-8"),
);
const runtimeSchema = JSON.parse(
  readFileSync(path.join(contractsDir, "runtime-instance.schema.json"), "utf-8"),
);

const contract = {
  contractVersion: "1.0",
  managerId: "arma3-server-manager",
  gameType: "arma3",
  displayName: "Arma 3",
  driver: { protocolVersion: "1.0", entrypoint: "manager_driver.py" },
  requiredContainerRoles: ["api", "frontend"],
  capabilities: ["discover", "adopt", "lifecycle", "health", "detach"],
  secretSlots: [{ id: "manager-secrets", provider: "podman", required: true }],
};

const manifest = {
  contractVersion: "1.0",
  instanceId: "a".repeat(32),
  managerId: "arma3-server-manager",
  gameType: "arma3",
  displayName: "Arma 3",
  driver: { protocolVersion: "1.0", command: ["/usr/bin/python3", "/trusted/manager_driver.py"] },
  capabilities: ["discover", "adopt", "lifecycle", "health", "detach"],
  resources: {
    containers: { api: "arma3-api", frontend: "arma3-frontend" },
    volumes: ["arma3-server"],
    networks: ["arma3-net"],
    ports: { web: 8080, port: 2302 },
  },
  images: { api: "localhost/api:20260804", frontend: "localhost/frontend:20260804" },
  config: { managerPath: "/srv/config/manager.toml" },
  secrets: [{ id: "manager-secrets", provider: "podman", reference: "arma3-manager-secrets" }],
  health: { type: "containers" },
  controllerRevision: 0,
};

describe("Contract v1 JSON Schemas", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateContract = ajv.compile(contractSchema);
  const validateRuntime = ajv.compile(runtimeSchema);

  it("accepts conforming repository and runtime manifests", () => {
    expect(validateContract(contract), JSON.stringify(validateContract.errors)).toBe(true);
    expect(validateRuntime(manifest), JSON.stringify(validateRuntime.errors)).toBe(true);
  });

  it("rejects duplicate capabilities and undeclared runtime fields", () => {
    expect(validateContract({ ...contract, capabilities: ["discover", "discover"] })).toBe(false);
    expect(validateRuntime({ ...manifest, password: "forbidden" })).toBe(false);
  });
});
