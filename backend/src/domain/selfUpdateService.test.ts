import { describe, expect, it } from "vitest";
import { dependencyManifestsChanged } from "./selfUpdateService.js";

describe("dependencyManifestsChanged", () => {
  it("is false when nothing dependency-related changed", () => {
    expect(dependencyManifestsChanged(["backend/src/server.ts", "README.md"])).toBe(false);
  });

  it("is true when the root package.json changed", () => {
    expect(dependencyManifestsChanged(["package.json", "backend/src/server.ts"])).toBe(true);
  });

  it("is true when the root package-lock.json changed", () => {
    expect(dependencyManifestsChanged(["package-lock.json"])).toBe(true);
  });

  it("is true when a workspace's package.json changed", () => {
    expect(dependencyManifestsChanged(["backend/package.json"])).toBe(true);
  });

  it("is false for files that merely contain 'package.json' as a substring", () => {
    expect(dependencyManifestsChanged(["backend/src/package.json.bak"])).toBe(false);
  });

  it("is false for an empty diff", () => {
    expect(dependencyManifestsChanged([])).toBe(false);
  });
});
