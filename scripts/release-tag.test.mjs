import { describe, expect, it } from "vitest";

import {
  classifyReleaseTag,
  validateVersionConsistency
} from "./release-tag.mjs";

describe("release tag classification", () => {
  it("classifies stable, alpha, and beta release tags", () => {
    expect(classifyReleaseTag("v0.4.6")).toEqual({
      version: "0.4.6",
      releaseKind: "stable",
      isPrerelease: false
    });
    expect(classifyReleaseTag("v0.4.6-alpha.1")).toEqual({
      version: "0.4.6-alpha.1",
      releaseKind: "prerelease",
      isPrerelease: true
    });
    expect(classifyReleaseTag("v0.4.6-beta.2")).toEqual({
      version: "0.4.6-beta.2",
      releaseKind: "prerelease",
      isPrerelease: true
    });
  });

  it.each([
    "v0.4.6-alpha",
    "v0.4.6-rc.1",
    "v0.4.6-test.1",
    "0.4.6",
    "v0.4",
    "v00.4.6",
    "v0.04.6",
    "v0.4.06",
    "v0.4.6-alpha.01"
  ])("rejects unsupported or invalid tag %s", (tag) => {
    expect(() => classifyReleaseTag(tag)).toThrow(/Invalid release tag/);
  });
});

describe("release version consistency", () => {
  it("accepts matching package and lockfile versions", () => {
    expect(() =>
      validateVersionConsistency("0.4.6-alpha.1", [
        { source: "package.json", version: "0.4.6-alpha.1" },
        {
          source: "apps/desktop/package.json",
          version: "0.4.6-alpha.1"
        },
        {
          source: 'package-lock.json#packages[""]',
          version: "0.4.6-alpha.1"
        }
      ])
    ).not.toThrow();
  });

  it("reports every mismatched or missing repository version", () => {
    expect(() =>
      validateVersionConsistency("0.4.6", [
        { source: "package.json", version: "0.4.6-alpha.1" },
        { source: "apps/desktop/package.json", version: "0.4.6" },
        { source: 'package-lock.json#packages[""]', version: undefined }
      ])
    ).toThrow(
      [
        'Release tag version "0.4.6" does not match repository package versions:',
        '- package.json: "0.4.6-alpha.1"',
        '- package-lock.json#packages[""]: <missing>'
      ].join("\n")
    );
  });
});
