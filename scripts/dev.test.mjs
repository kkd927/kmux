import path from "node:path";

import { describe, expect, it } from "vitest";

import { exitCodeForSignal, resolveDevProfileDirs } from "./dev.mjs";

describe("dev launcher", () => {
  it("converts child signal exits into cancellation exit codes", () => {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });

  it("treats blank profile root env values as absent", () => {
    const repoRoot = path.join(path.sep, "repo");

    expect(
      resolveDevProfileDirs({
        repoRoot,
        env: {
          KMUX_CONFIG_DIR: "   ",
          KMUX_RUNTIME_DIR: ""
        }
      })
    ).toEqual({
      configDir: path.join(repoRoot, ".kmux", "dev", "config"),
      runtimeDir: path.join(repoRoot, ".kmux", "dev", "runtime")
    });
  });

  it("trims explicit dev profile env values", () => {
    expect(
      resolveDevProfileDirs({
        repoRoot: path.join(path.sep, "repo"),
        env: {
          KMUX_CONFIG_DIR: " profiles/config ",
          KMUX_RUNTIME_DIR: " /tmp/kmux-runtime "
        }
      })
    ).toEqual({
      configDir: "profiles/config",
      runtimeDir: "/tmp/kmux-runtime"
    });
  });

  it("defaults to the current working directory when repoRoot is omitted", () => {
    const dirs = resolveDevProfileDirs({ env: {} });

    expect(dirs.configDir).toBe(
      path.join(process.cwd(), ".kmux", "dev", "config")
    );
    expect(dirs.runtimeDir).toBe(
      path.join(process.cwd(), ".kmux", "dev", "runtime")
    );
  });
});
