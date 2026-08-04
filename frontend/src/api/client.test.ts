import { describe, expect, it } from "vitest";
import { statusPresentation } from "./client.js";

describe("statusPresentation", () => {
  it("keeps operational and degraded states visually distinct", () => {
    expect(statusPresentation("running")).toEqual({ label: "Running", tone: "positive" });
    expect(statusPresentation("degraded")).toEqual({ label: "Degraded", tone: "warning" });
  });
});
