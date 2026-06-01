import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareVersions,
  createPendingUpdateStore,
  evaluatePendingInstall
} from "./pendingUpdate";

describe("compareVersions", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("0.3.10", "0.3.11")).toBe(-1);
    expect(compareVersions("0.3.11", "0.3.10")).toBe(1);
    expect(compareVersions("0.3.11", "0.3.11")).toBe(0);
    expect(compareVersions("0.4.0", "0.3.99")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  it("ignores prerelease suffixes and tolerates uneven lengths", () => {
    expect(compareVersions("0.3.11-beta.1", "0.3.11")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("0.3.1", "0.3")).toBe(1);
  });
});

describe("evaluatePendingInstall", () => {
  it("reports none when there is no recorded attempt", () => {
    expect(evaluatePendingInstall("0.3.10", null)).toEqual({ status: "none" });
    expect(evaluatePendingInstall("0.3.10", { version: "" })).toEqual({
      status: "none"
    });
  });

  it("reports incomplete when still behind the attempted version", () => {
    expect(evaluatePendingInstall("0.3.10", { version: "0.3.11" })).toEqual({
      status: "incomplete",
      version: "0.3.11"
    });
  });

  it("reports applied when at or beyond the attempted version", () => {
    expect(evaluatePendingInstall("0.3.11", { version: "0.3.11" })).toEqual({
      status: "applied",
      version: "0.3.11"
    });
    expect(evaluatePendingInstall("0.3.12", { version: "0.3.11" })).toEqual({
      status: "applied",
      version: "0.3.11"
    });
  });
});

describe("createPendingUpdateStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kmux-pending-"));
    filePath = join(dir, "nested", "pending-update.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records, reads, and clears the attempted version", () => {
    const store = createPendingUpdateStore(filePath);

    expect(store.read()).toBeNull();

    store.record("0.3.11");
    expect(store.read()).toEqual({ version: "0.3.11" });

    store.clear();
    expect(store.read()).toBeNull();
  });

  it("ignores blank versions and corrupt files", () => {
    const store = createPendingUpdateStore(filePath);

    store.record("   ");
    expect(store.read()).toBeNull();

    store.record("0.3.11");
    writeFileSync(filePath, "{ not json");
    expect(store.read()).toBeNull();
  });

  it("trims recorded versions", () => {
    const store = createPendingUpdateStore(filePath);
    store.record("  0.3.11  ");
    expect(store.read()).toEqual({ version: "0.3.11" });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      version: "0.3.11"
    });
  });
});
