import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  exitCodeForSignal,
  isConfiguredChromeSandbox,
  resolveDevElectronSandboxEnv,
  resolveDevProfileDirs
} from "./dev.mjs";

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

  it("accepts a root-owned setuid chrome sandbox helper", () => {
    expect(
      isConfiguredChromeSandbox(fakeStats({ uid: 0, gid: 0, mode: 0o104755 }))
    ).toBe(true);
  });

  it("rejects a user-owned chrome sandbox helper", () => {
    expect(
      isConfiguredChromeSandbox(
        fakeStats({ uid: 1000, gid: 1000, mode: 0o100755 })
      )
    ).toBe(false);
  });

  it("adds NO_SANDBOX for Linux dev Electron when the helper exists but is not configured", () => {
    const resolved = resolveDevElectronSandboxEnv({
      repoRoot: path.join(path.sep, "repo"),
      env: { PATH: "/bin" },
      platform: "linux",
      statFile: () => fakeStats({ uid: 1000, gid: 1000, mode: 0o100755 })
    });

    expect(resolved.env.NO_SANDBOX).toBe("1");
    expect(resolved.fallback).toEqual({
      chromeSandboxPath: path.join(
        path.sep,
        "repo",
        "node_modules",
        "electron",
        "dist",
        "chrome-sandbox"
      ),
      reason: "linux-dev-chrome-sandbox-helper-not-configured"
    });
  });

  it("preserves an explicit NO_SANDBOX value", () => {
    const resolved = resolveDevElectronSandboxEnv({
      repoRoot: path.join(path.sep, "repo"),
      env: { NO_SANDBOX: "0" },
      platform: "linux",
      statFile: () => fakeStats({ uid: 1000, gid: 1000, mode: 0o100755 })
    });

    expect(resolved.env.NO_SANDBOX).toBe("0");
    expect(resolved.fallback).toBeNull();
  });

  it("does not add NO_SANDBOX outside Linux", () => {
    const resolved = resolveDevElectronSandboxEnv({
      repoRoot: path.join(path.sep, "repo"),
      env: {},
      platform: "darwin",
      statFile: () => fakeStats({ uid: 1000, gid: 1000, mode: 0o100755 })
    });

    expect(resolved.env.NO_SANDBOX).toBeUndefined();
    expect(resolved.fallback).toBeNull();
  });
});

function fakeStats({ uid, gid, mode }) {
  return {
    uid,
    gid,
    mode,
    isFile: () => true
  };
}
