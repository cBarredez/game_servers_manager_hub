import { randomBytes } from "node:crypto";

/**
 * Turns a user-provided instance name into a short identifier safe to use in
 * Podman container/network/volume names ([a-zA-Z0-9][a-zA-Z0-9_.-]*) and as a
 * filesystem directory name, with a random suffix so two instances named the
 * same thing never collide.
 */
export function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const suffix = randomBytes(3).toString("hex");
  return base ? `${base}-${suffix}` : suffix;
}
