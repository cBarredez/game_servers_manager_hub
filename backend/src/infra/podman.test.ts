import { describe, expect, it } from "vitest";
import { parseByteSize } from "./podman.js";

describe("parseByteSize", () => {
  it("parses decimal SI units as podman stats/system df emit them", () => {
    expect(parseByteSize("516.1kB")).toBeCloseTo(516_100, 0);
    expect(parseByteSize("14.65GB")).toBeCloseTo(14_650_000_000, -3);
    expect(parseByteSize("1.784MB")).toBeCloseTo(1_784_000, 0);
  });

  it("parses binary units too, in case a podman version emits them", () => {
    expect(parseByteSize("1MiB")).toBe(1024 * 1024);
    expect(parseByteSize("1GiB")).toBe(1024 ** 3);
  });

  it("parses a bare byte count with no unit", () => {
    expect(parseByteSize("512")).toBe(512);
    expect(parseByteSize("0B")).toBe(0);
  });

  it("returns 0 for unparseable input instead of throwing", () => {
    expect(parseByteSize("")).toBe(0);
    expect(parseByteSize("n/a")).toBe(0);
  });
});
