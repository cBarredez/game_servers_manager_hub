import type { MaintenanceService } from "../domain/maintenanceService.js";

/**
 * Ticks the maintenance service on a fixed interval, matching the plain
 * setInterval shape proyect_zomboid's own scheduled-backup timer uses
 * (backend/src/server.ts). Returns a stop function; failures in one tick are
 * logged and swallowed so a transient podman/filesystem error never kills
 * the whole hub process.
 *
 * Also runs one tick immediately on start, not just after the first
 * interval — instances that were running before the hub (or the whole host)
 * went down shouldn't have to wait up to intervalMs before auto-restart even
 * notices they're down.
 */
export function startMaintenanceScheduler(service: MaintenanceService, intervalMs = 60_000): () => void {
  const run = () => {
    service.tick().catch((error) => {
      console.error("maintenance tick failed", error);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
