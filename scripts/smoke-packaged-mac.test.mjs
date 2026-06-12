import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findDmgPath, parseArgs } from "./smoke-packaged-mac.mjs";

describe("packaged mac smoke", () => {
  it("parses an explicit DMG path", () => {
    expect(parseArgs(["--dmg", "apps/desktop/release/kmux.dmg"])).toEqual({
      dmgPath: path.resolve("apps/desktop/release/kmux.dmg")
    });
  });

  it("parses empty arguments", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("rejects a missing DMG path", () => {
    expect(() => parseArgs(["--dmg"])).toThrow(/--dmg requires a path value/);
    expect(() => parseArgs(["--dmg", "--other"])).toThrow(
      /--dmg requires a path value/
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--allow-any-platform"])).toThrow(
      /unknown smoke:packaged:mac argument/
    );
  });

  it("selects the newest DMG from the first populated release root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-mac-smoke-test-"));
    try {
      const primary = path.join(root, "primary");
      const fallback = path.join(root, "fallback");
      mkdirSync(primary);
      mkdirSync(fallback);

      const oldPrimaryDmg = path.join(primary, "kmux-0.3.11-mac-x64.dmg");
      const newPrimaryDmg = path.join(primary, "kmux-0.3.12-mac-x64.dmg");
      const newerFallbackDmg = path.join(fallback, "kmux-0.3.13-mac-x64.dmg");
      writeFileSync(oldPrimaryDmg, "old");
      writeFileSync(newPrimaryDmg, "new");
      writeFileSync(newerFallbackDmg, "fallback");

      utimesSync(oldPrimaryDmg, new Date(1000), new Date(1000));
      utimesSync(newPrimaryDmg, new Date(2000), new Date(2000));
      utimesSync(newerFallbackDmg, new Date(3000), new Date(3000));

      expect(findDmgPath(undefined, [primary, fallback])).toBe(newPrimaryDmg);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
