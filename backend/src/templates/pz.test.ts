import { describe, expect, it } from "vitest";
import { pzTemplate } from "./pz.js";

const baseCtx = { id: "abc", slug: "my-slug", name: "PZ Test", mock: false, configDir: "/x", memoryMb: 4096, diskGb: 0 };

describe("pzTemplate", () => {
  it("allocates non-overlapping game-port ranges across consecutive instances", () => {
    const first = pzTemplate.allocatePorts(0, 9000);
    const second = pzTemplate.allocatePorts(1, 9001);

    expect(second.gamePort).toBeGreaterThan(first.gamePort + 100);
    expect(second.rconPort).not.toBe(first.rconPort);
    expect(second.steamQueryPort1).not.toBe(first.steamQueryPort1);
    expect(second.steamQueryPort2).not.toBe(first.steamQueryPort2);
  });

  it("lists every published port for host-availability checks", () => {
    const ports = pzTemplate.allocatePorts(0, 9000);
    const checks = pzTemplate.portsToCheck(ports);
    expect(checks).toHaveLength(5);
    expect(checks.map((c) => c.port).sort()).toEqual(
      [ports.web, ports.gamePort, ports.rconPort, ports.steamQueryPort1, ports.steamQueryPort2].sort(),
    );
  });

  it("escapes the instance name when rendering server_name and applies the memory limit", () => {
    const ports = pzTemplate.allocatePorts(0, 9000);
    const toml = pzTemplate.renderConfigToml(
      { ...baseCtx, name: 'Weird "Name"' },
      ports,
    );

    expect(toml).toContain('server_name = "Weird \\"Name\\""');
    expect(toml).toContain(`game_port = ${ports.gamePort}`);
    expect(toml).toContain(`rcon_port = ${ports.rconPort}`);
    expect(toml).toContain(`memory_limit_mb = ${baseCtx.memoryMb}`);
    expect(toml).toContain("mock_steamcmd = false");
  });

  it("gives the api container headroom above the configured JVM heap size", () => {
    const ports = pzTemplate.allocatePorts(0, 9000);
    const args = pzTemplate.apiRunArgs({ ...baseCtx, memoryMb: 4096 }, ports);
    const memIndex = args.indexOf("--memory");
    expect(args[memIndex + 1]).toBe("6144m");
  });

  it("marks the install/data/backups volumes as sizeable but not steamcmd", () => {
    const volumes = pzTemplate.volumes("my-slug");
    const sizeable = volumes.filter((v) => v.sizeable).map((v) => v.name);
    expect(sizeable).toEqual(
      expect.arrayContaining([expect.stringContaining("pz-install"), expect.stringContaining("pz-data")]),
    );
    expect(volumes.find((v) => v.name.includes("steamcmd"))?.sizeable).toBe(false);
  });

  it("generates secrets including an admin_password field", () => {
    const secrets = pzTemplate.generateSecrets(baseCtx);
    expect(secrets.content).toContain("admin_password");
    expect(secrets.content).toContain(secrets.initialPassword);
  });

});
