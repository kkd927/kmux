import { describe, expect, it } from "vitest";

import { resolveAutoUpdaterChannel } from "./updaterChannel";

describe("auto updater channel selection", () => {
  it("keeps the existing macOS arm64 channel override", () => {
    expect(
      resolveAutoUpdaterChannel({
        platform: "darwin",
        arch: "arm64"
      })
    ).toBe("latest-arm64");
  });

  it("uses electron-updater Linux default channel metadata naming", () => {
    expect(
      resolveAutoUpdaterChannel({
        platform: "linux",
        arch: "arm64"
      })
    ).toBeNull();
    expect(
      resolveAutoUpdaterChannel({
        platform: "linux",
        arch: "x64"
      })
    ).toBeNull();
  });
});
