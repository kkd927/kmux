import path from "node:path";
import { constants } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ensureElectronBinaryDownloaded,
  exitCodeForSignal,
  isConfiguredChromeSandbox,
  resolveElectronOverrideExecutablePath,
  resolveDevAppEnv,
  resolveInstallElectronCommand,
  resolveDevElectronSandboxEnv,
  resolveDevProfileDirs,
  resetDevState,
  shouldResetDevState
} from "./dev.mjs";

describe("dev launcher", () => {
  it("converts child signal exits into cancellation exit codes", () => {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });

  it("treats blank profile root env values as absent", () => {
    const repoRoot = path.join(path.sep, "repo");
    const configDir = path.join(repoRoot, ".kmux", "dev", "config");
    const runtimeDir = path.join(repoRoot, ".kmux", "dev", "runtime");

    expect(
      resolveDevProfileDirs({
        repoRoot,
        env: {
          KMUX_CONFIG_DIR: "   ",
          KMUX_RUNTIME_DIR: ""
        }
      })
    ).toEqual({
      configDir,
      runtimeDir,
      stateDir: configDir,
      dataDir: configDir,
      cacheDir: runtimeDir,
      socketPath: path.join(runtimeDir, "control.sock"),
      rawOutputRoot: path.join(configDir, "pty-raw"),
      nativeCacheRoot: path.join(runtimeDir, "native"),
      agentHookBinDir: path.join(configDir, "bin"),
      agentWrapperBinDir: path.join(configDir, "wrappers"),
      electronUserDataDir: path.join(runtimeDir, "electron-user-data")
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
      runtimeDir: "/tmp/kmux-runtime",
      stateDir: "profiles/config",
      dataDir: "profiles/config",
      cacheDir: "/tmp/kmux-runtime",
      socketPath: path.join("/tmp/kmux-runtime", "control.sock"),
      rawOutputRoot: path.join("profiles/config", "pty-raw"),
      nativeCacheRoot: path.join("/tmp/kmux-runtime", "native"),
      agentHookBinDir: path.join("profiles/config", "bin"),
      agentWrapperBinDir: path.join("profiles/config", "wrappers"),
      electronUserDataDir: path.join(
        "/tmp/kmux-runtime",
        "electron-user-data"
      )
    });
  });

  it("honors explicit dev state, data, and cache roots", () => {
    expect(
      resolveDevProfileDirs({
        repoRoot: path.join(path.sep, "repo"),
        env: {
          KMUX_CONFIG_DIR: "/profiles/config",
          KMUX_RUNTIME_DIR: "/profiles/runtime",
          KMUX_STATE_DIR: " /profiles/state ",
          KMUX_DATA_DIR: " /profiles/data ",
          KMUX_CACHE_DIR: " /profiles/cache "
        }
      })
    ).toEqual({
      configDir: "/profiles/config",
      runtimeDir: "/profiles/runtime",
      stateDir: "/profiles/state",
      dataDir: "/profiles/data",
      cacheDir: "/profiles/cache",
      socketPath: path.join("/profiles/runtime", "control.sock"),
      rawOutputRoot: path.join("/profiles/state", "pty-raw"),
      nativeCacheRoot: path.join("/profiles/cache", "native"),
      agentHookBinDir: path.join("/profiles/data", "bin"),
      agentWrapperBinDir: path.join("/profiles/data", "wrappers"),
      electronUserDataDir: path.join("/profiles/cache", "electron-user-data")
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
    expect(dirs.stateDir).toBe(dirs.configDir);
    expect(dirs.dataDir).toBe(dirs.configDir);
    expect(dirs.cacheDir).toBe(dirs.runtimeDir);
    expect(dirs.socketPath).toBe(path.join(dirs.runtimeDir, "control.sock"));
    expect(dirs.electronUserDataDir).toBe(
      path.join(dirs.runtimeDir, "electron-user-data")
    );
  });

  it("builds an isolated dev app env instead of inheriting a parent kmux surface", () => {
    const repoRoot = path.join(path.sep, "repo");
    const env = resolveDevAppEnv({
      repoRoot,
      env: {
        PATH: "/bin",
        KMUX_SOCKET_PATH: "/Users/test/.kmux/control.sock",
        KMUX_SOCKET_MODE: "kmuxOnly",
        KMUX_AUTH_TOKEN: "parent-auth-token",
        KMUX_RAW_OUTPUT_ROOT: "/Users/test/.config/kmux/pty-raw",
        KMUX_NATIVE_CACHE_ROOT: "/Users/test/.kmux/native",
        KMUX_ELECTRON_USER_DATA_DIR:
          "/Users/test/Library/Application Support/@kmux/desktop",
        KMUX_AGENT_BIN_DIR: "/Users/test/.config/kmux/bin",
        KMUX_AGENT_WRAPPER_BIN_DIR: "/Users/test/.config/kmux/wrappers",
        KMUX_NODE_PATH: "/Applications/kmux.app/Contents/MacOS/kmux",
        KMUX_WORKSPACE_ID: "workspace_packaged",
        KMUX_PANE_ID: "pane_packaged",
        KMUX_SURFACE_ID: "surface_packaged",
        KMUX_SESSION_ID: "session_packaged",
        KMUX_HOOK_AGENT: "codex",
        KMUX_HOOK_EVENT: "Stop",
        KMUX_AGENT_HOOK_OUTPUT_MODE: "json",
        KMUX_SHELL_INTEGRATION: "1",
        KMUX_ZSH_WRAPPER_DIR: "/Users/test/.kmux/shell-wrappers/kmux-zsh-app",
        KMUX_ZSH_INTEGRATION_SCRIPT: "/tmp/kmux.zsh",
        KMUX_BASH_INTEGRATION_SCRIPT: "/tmp/kmux.bash",
        KMUX_FISH_INTEGRATION_SCRIPT: "/tmp/kmux.fish",
        KMUX_ORIGINAL_HOME: "/Users/test",
        KMUX_ORIGINAL_ZDOTDIR: "/Users/test",
        KMUX_ORIGINAL_HISTFILE: "/Users/test/.zsh_history",
        KMUX_ORIGINAL_XDG_CONFIG_HOME: "/Users/test/.config",
        KMUX_CLI_PATH: "/Applications/kmux.app/Contents/Resources/kmux",
        KMUX_AGENT_HELPER_PATH:
          "/Applications/kmux.app/Contents/Resources/kmux-agent-hook",
        KMUX_NODE_RUNTIME: "/Applications/kmux.app/Contents/MacOS/kmux",
        __KMUX_OSC7_INSTALLED: "1"
      }
    });

    const configDir = path.join(repoRoot, ".kmux", "dev", "config");
    const runtimeDir = path.join(repoRoot, ".kmux", "dev", "runtime");

    expect(env.PATH).toBe("/bin");
    expect(env.KMUX_CONFIG_DIR).toBe(configDir);
    expect(env.KMUX_RUNTIME_DIR).toBe(runtimeDir);
    expect(env.KMUX_STATE_DIR).toBe(configDir);
    expect(env.KMUX_DATA_DIR).toBe(configDir);
    expect(env.KMUX_CACHE_DIR).toBe(runtimeDir);
    expect(env.KMUX_SOCKET_PATH).toBe(path.join(runtimeDir, "control.sock"));
    expect(env.KMUX_RAW_OUTPUT_ROOT).toBe(path.join(configDir, "pty-raw"));
    expect(env.KMUX_NATIVE_CACHE_ROOT).toBe(path.join(runtimeDir, "native"));
    expect(env.KMUX_AGENT_BIN_DIR).toBe(path.join(configDir, "bin"));
    expect(env.KMUX_AGENT_WRAPPER_BIN_DIR).toBe(
      path.join(configDir, "wrappers")
    );
    expect(env.KMUX_ELECTRON_USER_DATA_DIR).toBe(
      path.join(runtimeDir, "electron-user-data")
    );
    expect(env.KMUX_SOCKET_MODE).toBeUndefined();
    expect(env.KMUX_AUTH_TOKEN).toBeUndefined();
    expect(env.KMUX_NODE_PATH).toBeUndefined();
    expect(env.KMUX_WORKSPACE_ID).toBeUndefined();
    expect(env.KMUX_PANE_ID).toBeUndefined();
    expect(env.KMUX_SURFACE_ID).toBeUndefined();
    expect(env.KMUX_SESSION_ID).toBeUndefined();
    expect(env.KMUX_HOOK_AGENT).toBeUndefined();
    expect(env.KMUX_HOOK_EVENT).toBeUndefined();
    expect(env.KMUX_AGENT_HOOK_OUTPUT_MODE).toBeUndefined();
    expect(env.KMUX_SHELL_INTEGRATION).toBeUndefined();
    expect(env.KMUX_ZSH_WRAPPER_DIR).toBeUndefined();
    expect(env.KMUX_ZSH_INTEGRATION_SCRIPT).toBeUndefined();
    expect(env.KMUX_BASH_INTEGRATION_SCRIPT).toBeUndefined();
    expect(env.KMUX_FISH_INTEGRATION_SCRIPT).toBeUndefined();
    expect(env.KMUX_ORIGINAL_HOME).toBeUndefined();
    expect(env.KMUX_ORIGINAL_ZDOTDIR).toBeUndefined();
    expect(env.KMUX_ORIGINAL_HISTFILE).toBeUndefined();
    expect(env.KMUX_ORIGINAL_XDG_CONFIG_HOME).toBeUndefined();
    expect(env.KMUX_CLI_PATH).toBeUndefined();
    expect(env.KMUX_AGENT_HELPER_PATH).toBeUndefined();
    expect(env.KMUX_NODE_RUNTIME).toBeUndefined();
    expect(env.__KMUX_OSC7_INSTALLED).toBeUndefined();
  });

  it("resets dev workspace state by default", () => {
    const calls = [];
    const result = resetDevState({
      stateDir: path.join(path.sep, "repo", ".kmux", "dev", "config"),
      env: {},
      rmFile: (statePath, options) => {
        calls.push({ statePath, options });
      }
    });

    expect(result).toEqual({
      reset: true,
      statePath: path.join(
        path.sep,
        "repo",
        ".kmux",
        "dev",
        "config",
        "state.json"
      )
    });
    expect(calls).toEqual([
      {
        statePath: result.statePath,
        options: { force: true }
      }
    ]);
  });

  it("can preserve dev workspace state for restore debugging", () => {
    const calls = [];

    expect(shouldResetDevState({ KMUX_DEV_RESTORE_STATE: "1" })).toBe(false);
    expect(
      resetDevState({
        stateDir: path.join(path.sep, "repo", ".kmux", "dev", "config"),
        env: { KMUX_DEV_RESTORE_STATE: "1" },
        rmFile: (statePath, options) => {
          calls.push({ statePath, options });
        }
      })
    ).toEqual({ reset: false, statePath: null });
    expect(calls).toHaveLength(0);
  });

  it("resolves the Electron 42 lazy-download helper from local node_modules", () => {
    expect(
      resolveInstallElectronCommand({
        repoRoot: path.join(path.sep, "repo"),
        platform: "darwin"
      })
    ).toBe(
      path.join(path.sep, "repo", "node_modules", ".bin", "install-electron")
    );
    expect(
      resolveInstallElectronCommand({
        repoRoot: "C:\\repo",
        platform: "win32"
      })
    ).toBe(
      path.join("C:\\repo", "node_modules", ".bin", "install-electron.cmd")
    );
  });

  it("runs Electron's lazy installer before sandbox checks", () => {
    const calls = [];
    const result = ensureElectronBinaryDownloaded({
      repoRoot: path.join(path.sep, "repo"),
      env: { PATH: "/bin" },
      platform: "linux",
      spawnSyncFn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      }
    });

    expect(result).toEqual({
      ran: true,
      command: path.join(
        path.sep,
        "repo",
        "node_modules",
        ".bin",
        "install-electron"
      )
    });
    expect(calls).toEqual([
      {
        command: result.command,
        args: ["--no"],
        options: {
          cwd: path.join(path.sep, "repo"),
          env: { PATH: "/bin" },
          stdio: "inherit"
        }
      }
    ]);
  });

  it("uses Electron path.txt when validating ELECTRON_OVERRIDE_DIST_PATH", () => {
    const spawnCalls = [];
    const accessCalls = [];
    const result = ensureElectronBinaryDownloaded({
      repoRoot: path.join(path.sep, "repo"),
      env: {
        ELECTRON_OVERRIDE_DIST_PATH: ` ${path.join(path.sep, "custom-electron")} `
      },
      platform: "darwin",
      readFile: () => "Electron.app/Contents/MacOS/Electron\n",
      accessFile: (electronPath, mode) => {
        accessCalls.push({ electronPath, mode });
      },
      spawnSyncFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { status: 0 };
      }
    });

    expect(result).toEqual({
      ran: false,
      command: null,
      reason: "electron-override-dist-path",
      electronPath: path.join(
        path.sep,
        "custom-electron",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron"
      )
    });
    expect(accessCalls).toEqual([
      {
        electronPath: result.electronPath,
        mode: constants.X_OK
      }
    ]);
    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to the Linux Electron override executable when path.txt is absent", () => {
    const accessCalls = [];
    const result = ensureElectronBinaryDownloaded({
      repoRoot: path.join(path.sep, "repo"),
      env: {
        ELECTRON_OVERRIDE_DIST_PATH: path.join(path.sep, "offline-electron")
      },
      platform: "linux",
      readFile: () => {
        throw new Error("missing path.txt");
      },
      accessFile: (electronPath, mode) => {
        accessCalls.push({ electronPath, mode });
      },
      spawnSyncFn: () => {
        throw new Error("install-electron should not run");
      }
    });

    expect(result).toEqual({
      ran: false,
      command: null,
      reason: "electron-override-dist-path",
      electronPath: path.join(path.sep, "offline-electron", "electron")
    });
    expect(accessCalls).toEqual([
      {
        electronPath: result.electronPath,
        mode: constants.X_OK
      }
    ]);
  });

  it("matches Electron's override fallback when path.txt is absent on Windows", () => {
    const result = ensureElectronBinaryDownloaded({
      repoRoot: "C:\\repo",
      env: {
        ELECTRON_OVERRIDE_DIST_PATH: "C:\\electron-dist"
      },
      platform: "win32",
      readFile: () => {
        throw new Error("missing path.txt");
      },
      accessFile: () => {},
      spawnSyncFn: () => {
        throw new Error("install-electron should not run");
      }
    });

    expect(result).toEqual({
      ran: false,
      command: null,
      reason: "electron-override-dist-path",
      electronPath: path.join("C:\\electron-dist", "electron")
    });
  });

  it("matches Electron's override fallback when path.txt is absent", () => {
    for (const platform of ["darwin", "freebsd", "openbsd"]) {
      expect(
        resolveElectronOverrideExecutablePath({
          repoRoot: path.join(path.sep, "repo"),
          env: {
            ELECTRON_OVERRIDE_DIST_PATH: path.join(path.sep, platform)
          },
          platform,
          readFile: () => {
            throw new Error("missing path.txt");
          }
        })
      ).toBe(path.join(path.sep, platform, "electron"));
    }
  });

  it("fails fast when ELECTRON_OVERRIDE_DIST_PATH does not contain a usable executable", () => {
    const spawnCalls = [];

    expect(() =>
      ensureElectronBinaryDownloaded({
        repoRoot: path.join(path.sep, "repo"),
        env: {
          ELECTRON_OVERRIDE_DIST_PATH: path.join(path.sep, "missing-electron")
        },
        platform: "linux",
        readFile: () => "electron\n",
        accessFile: () => {
          throw new Error("not found");
        },
        spawnSyncFn: (command, args, options) => {
          spawnCalls.push({ command, args, options });
          return { status: 0 };
        }
      })
    ).toThrow(
      "ELECTRON_OVERRIDE_DIST_PATH is set but the Electron executable is not usable."
    );
    expect(spawnCalls).toHaveLength(0);
  });

  it("lets install-electron repair partial lazy materialization even when dist exists", () => {
    const calls = [];
    const result = ensureElectronBinaryDownloaded({
      repoRoot: path.join(path.sep, "repo"),
      platform: "linux",
      spawnSyncFn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      }
    });

    expect(result).toEqual({
      ran: true,
      command: path.join(
        path.sep,
        "repo",
        "node_modules",
        ".bin",
        "install-electron"
      )
    });
    expect(calls).toHaveLength(1);
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
