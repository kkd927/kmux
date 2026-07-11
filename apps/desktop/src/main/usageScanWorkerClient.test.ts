import { describe, expect, it } from "vitest";

import { resolveUsageScanWorkerLaunchOptions } from "./usageScanWorkerClient";

describe("usage scan worker launch", () => {
  it("resolves the bundled worker inside app.asar with an unpacked cwd", () => {
    expect(
      resolveUsageScanWorkerLaunchOptions(
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
        "production",
        "/Applications/kmux.app/Contents/Resources"
      )
    ).toEqual({
      entry:
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main/usageScanWorker.js",
      cwd: "/Applications/kmux.app/Contents/Resources/app.asar.unpacked",
      execArgv: []
    });
  });

  it("resolves the built worker for a production repository launch", () => {
    expect(
      resolveUsageScanWorkerLaunchOptions(
        "/Users/test/kmux/apps/desktop/out/main",
        "production"
      )
    ).toEqual({
      entry: "/Users/test/kmux/apps/desktop/out/main/usageScanWorker.js",
      cwd: "/Users/test/kmux",
      execArgv: []
    });
  });

  it("runs the TypeScript worker through tsx during development", () => {
    expect(
      resolveUsageScanWorkerLaunchOptions(
        "/Users/test/kmux/apps/desktop/src/main",
        "development"
      )
    ).toEqual({
      entry: "/Users/test/kmux/apps/desktop/src/main/usageScanWorker.ts",
      cwd: "/Users/test/kmux",
      execArgv: ["--import", "tsx"]
    });
  });
});
