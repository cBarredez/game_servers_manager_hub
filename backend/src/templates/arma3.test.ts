import { describe, expect, it } from "vitest";
import { arma3Template } from "./arma3.js";

const baseCtx = { id: "abc", slug: "test-slug", name: "My Instance", mock: true, configDir: "/x", memoryMb: 8192, diskGb: 0 };

describe("arma3Template", () => {
  it("allocates non-overlapping 4-port UDP blocks across consecutive instances", () => {
    const first = arma3Template.allocatePorts(0, 9000);
    const second = arma3Template.allocatePorts(1, 9001);

    const firstPorts = [first.port, first.queryPort, first.battleyePort, first.vonPort];
    const secondPorts = [second.port, second.queryPort, second.battleyePort, second.vonPort];

    for (const port of firstPorts) {
      expect(secondPorts).not.toContain(port);
    }
    expect(new Set(firstPorts).size).toBe(4);
  });

  it("lists exactly the published ports for host-availability checks (rcon excluded, it's container-internal only)", () => {
    const ports = arma3Template.allocatePorts(0, 9000);
    const checks = arma3Template.portsToCheck(ports);

    expect(checks).toHaveLength(5);
    expect(checks.find((c) => c.port === ports.rconPort)).toBeUndefined();
    expect(checks.filter((c) => c.protocol === "udp")).toHaveLength(4);
    expect(checks.filter((c) => c.protocol === "tcp")).toHaveLength(1);
  });

  it("renders a manager.toml whose ports and memory match the given context", () => {
    const ports = arma3Template.allocatePorts(0, 9000);
    const toml = arma3Template.renderConfigToml(baseCtx, ports);

    expect(toml).toContain(`public_port = ${ports.web}`);
    expect(toml).toContain(`port = ${ports.port}`);
    expect(toml).toContain(`query_port = ${ports.queryPort}`);
    expect(toml).toContain(`battleye_port = ${ports.battleyePort}`);
    expect(toml).toContain(`von_port = ${ports.vonPort}`);
    expect(toml).toContain(`memory_limit = "${baseCtx.memoryMb}m"`);
    expect(toml).toContain("mock_server = true");
    expect(toml).toContain("mock_steamcmd = true");
  });

  it("applies the requested memory limit to the api container's --memory flag", () => {
    const ports = arma3Template.allocatePorts(0, 9000);
    const args = arma3Template.apiRunArgs({ ...baseCtx, memoryMb: 12000 }, ports);
    const memIndex = args.indexOf("--memory");
    expect(args[memIndex + 1]).toBe("12000m");
  });

  it("generates a plaintext initial password different from the stored hash-less secret file", () => {
    const secrets = arma3Template.generateSecrets(baseCtx);
    expect(secrets.initialPassword.length).toBeGreaterThan(0);
    expect(secrets.content).toContain(secrets.initialPassword);
    expect(secrets.content).toContain("session_secret");
  });

  it("mounts manager secrets through Podman secrets rather than a config-directory bind", () => {
    const args = arma3Template.apiRunArgs(baseCtx, arma3Template.allocatePorts(0, 9000));
    expect(args).toContain("--secret");
    expect(args).toContain("arma3-manager-secrets-test-slug,target=manager.secrets.toml");
    expect(args).not.toContain("/x:/app/config:ro");
  });

});
