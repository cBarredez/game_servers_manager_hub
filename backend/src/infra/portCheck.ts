import { createServer } from "node:net";
import { createSocket } from "node:dgram";

/** True if nothing on the host is currently bound to this TCP port. */
export function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

/** True if nothing on the host is currently bound to this UDP port. */
export function isUdpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.once("error", () => resolve(false));
    socket.once("listening", () => socket.close(() => resolve(true)));
    socket.bind(port, "0.0.0.0");
  });
}

export interface PortCheck {
  port: number;
  protocol: "tcp" | "udp";
}

/** True only if every listed port is actually free on the host right now. */
export async function allPortsFree(checks: PortCheck[]): Promise<boolean> {
  for (const check of checks) {
    const free = check.protocol === "tcp" ? await isTcpPortFree(check.port) : await isUdpPortFree(check.port);
    if (!free) return false;
  }
  return true;
}
