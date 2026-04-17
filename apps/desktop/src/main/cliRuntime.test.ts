import { describe, expect, it } from "vitest";

import { resolveCliRuntimePaths } from "./cliRuntime";

describe("resolveCliRuntimePaths", () => {
  it("uses the packaged CLI resource when running from a packaged app", () => {
    const cli = resolveCliRuntimePaths({
      currentDir: "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
      isPackaged: true,
      resourcesPath: "/Applications/kmux.app/Contents/Resources",
      processExecPath: "/Applications/kmux.app/Contents/MacOS/kmux",
      pathExists: (path) =>
        path === "/Applications/kmux.app/Contents/Resources/cli/bin.cjs"
    });

    expect(cli).toEqual({
      cliPath: "/Applications/kmux.app/Contents/Resources/cli/bin.cjs",
      cliWorkingDirectory: "/Applications/kmux.app/Contents/Resources",
      nodePath: "/Applications/kmux.app/Contents/MacOS/kmux"
    });
  });

  it("prefers the built CLI bundle during local development", () => {
    const cli = resolveCliRuntimePaths({
      currentDir: "/Users/test/kmux/apps/desktop/out/main",
      processExecPath: "/Users/test/kmux/node_modules/.bin/electron",
      pathExists: (path) => path === "/Users/test/kmux/packages/cli/dist/bin.cjs",
      resolveTsxLoaderPath: () => "/Users/test/kmux/node_modules/tsx/dist/loader.mjs"
    });

    expect(cli).toEqual({
      cliPath: "/Users/test/kmux/packages/cli/dist/bin.cjs",
      cliWorkingDirectory: "/Users/test/kmux",
      nodePath: "/Users/test/kmux/node_modules/.bin/electron"
    });
  });

  it("falls back to the TypeScript source entry when the built CLI is missing", () => {
    const cli = resolveCliRuntimePaths({
      currentDir: "/Users/test/kmux/apps/desktop/src/main",
      processExecPath: "/Users/test/kmux/node_modules/.bin/electron",
      pathExists: (path) =>
        path === "/Users/test/kmux/packages/cli/src/bin.ts" ||
        path === "/Users/test/kmux/node_modules/tsx/dist/loader.mjs",
      resolveTsxLoaderPath: () => "/Users/test/kmux/node_modules/tsx/dist/loader.mjs"
    });

    expect(cli).toEqual({
      cliPath: "/Users/test/kmux/packages/cli/src/bin.ts",
      cliWorkingDirectory: "/Users/test/kmux",
      cliTsxLoaderPath: "/Users/test/kmux/node_modules/tsx/dist/loader.mjs",
      nodePath: "/Users/test/kmux/node_modules/.bin/electron"
    });
  });

  it("returns a clear warning when no usable CLI entry is available", () => {
    const cli = resolveCliRuntimePaths({
      currentDir: "/Users/test/kmux/apps/desktop/src/main",
      processExecPath: "/Users/test/kmux/node_modules/.bin/electron",
      pathExists: () => false,
      resolveTsxLoaderPath: () => undefined
    });

    expect(cli.cliPath).toBeUndefined();
    expect(cli.nodePath).toBe("/Users/test/kmux/node_modules/.bin/electron");
    expect(cli.warning).toContain("agent hook forwarding is disabled");
    expect(cli.warning).toContain("/Users/test/kmux/packages/cli/dist/bin.cjs");
    expect(cli.warning).toContain("/Users/test/kmux/packages/cli/src/bin.ts");
  });
});
