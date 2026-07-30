import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { isTcpPortFree, isUdpPortFree } from "./portCheck.js";

describe("portCheck", () => {
  it("detects an occupied TCP port as not free", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;

    expect(await isTcpPortFree(port)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isTcpPortFree(port)).toBe(true);
  });

  it("treats an unused high port as free for both protocols", async () => {
    const candidate = 39123;
    expect(await isTcpPortFree(candidate)).toBe(true);
    expect(await isUdpPortFree(candidate)).toBe(true);
  });
});
