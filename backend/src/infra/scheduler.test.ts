import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMaintenanceScheduler } from "./scheduler.js";
import type { MaintenanceService } from "../domain/maintenanceService.js";

// Lets any already-queued microtasks (e.g. a mocked tick()'s .catch() chain)
// settle without needing real timers — fake timers only replace
// setTimeout/setInterval, not Promise microtask scheduling.
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

describe("startMaintenanceScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately on start instead of waiting for the first interval", () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const service = { tick } as unknown as MaintenanceService;

    const stop = startMaintenanceScheduler(service, 60_000);

    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps ticking on the configured interval after the initial tick", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const service = { tick } as unknown as MaintenanceService;

    const stop = startMaintenanceScheduler(service, 60_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(3);

    stop();
  });

  it("stops ticking once the returned stop function is called", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const service = { tick } as unknown as MaintenanceService;

    const stop = startMaintenanceScheduler(service, 60_000);
    expect(tick).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected tick instead of crashing the process", async () => {
    const tick = vi.fn().mockRejectedValue(new Error("podman unreachable"));
    const service = { tick } as unknown as MaintenanceService;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stop = startMaintenanceScheduler(service, 60_000);
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith("maintenance tick failed", expect.any(Error));

    stop();
    errorSpy.mockRestore();
  });
});
