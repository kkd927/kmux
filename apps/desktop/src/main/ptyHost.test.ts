import {describe, expect, it} from "vitest";

import {resolvePtyHostLaunchOptions} from "./ptyHost";

describe("resolvePtyHostLaunchOptions", () => {
  it("uses the unpacked pty-host bundle when running from app.asar", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
      "production",
      "/Applications/kmux.app/Contents/Resources"
    );

    expect(launch).toEqual({
      entry:
        "/Applications/kmux.app/Contents/Resources/app.asar.unpacked/dist/pty-host/index.cjs",
      cwd: "/Applications/kmux.app/Contents/Resources",
      execArgv: []
    });
  });

  it("uses the production build output when running unpackaged in production", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Users/test/kmux/apps/desktop/out/main",
      "production"
    );

    expect(launch).toEqual({
      entry: "/Users/test/kmux/apps/desktop/dist/pty-host/index.cjs",
      cwd: "/Users/test/kmux",
      execArgv: []
    });
  });

  it("uses the tsx source entry during development", () => {
    const launch = resolvePtyHostLaunchOptions(
      "/Users/test/kmux/apps/desktop/src/main",
      "development"
    );

    expect(launch).toEqual({
      entry: "/Users/test/kmux/apps/desktop/src/pty-host/index.ts",
      cwd: "/Users/test/kmux",
      execArgv: ["--import", "tsx"]
    });
  });
});
