import { describe, expect, it } from "vitest";
import { getLegacyTemplateAdapter } from "./index.js";

describe("LegacyTemplateAdapter", () => {
  it("keeps Project Zomboid operational without advertising adoption", () => {
    const adapter = getLegacyTemplateAdapter("pz");
    expect(adapter.template.displayName).toBe("Project Zomboid");
    expect(adapter.supportsAdoption).toBe(false);
  });
});
