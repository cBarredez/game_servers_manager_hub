import type { MaintenanceService } from "../domain/maintenanceService.js";

/**
 * Ticks the maintenance service on a fixed interval, matching the plain
 * setInterval shape proyect_zomboid's own scheduled-backup timer uses
 * (backend/src/server.ts). Returns a stop function; failures in one tick are
 * logged and swallowed so a transient podman/filesystem error never kills
 * the whole hub process.
 */
export function startMaintenanceScheduler(service: MaintenanceService, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    service.tick().catch((error) => {
      console.error("maintenance tick failed", error);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
