import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";

import {
  buildShellEnvProbeArgs,
  buildShellEnvProbeInvocation,
  parseShellEnvOutput,
  resolveShellEnvironment,
  resolveShellEnvProbeLaunchOptions,
  resolveShellPath,
  shouldUsePtyShellEnvProbe,
  type ShellCommandExecutor,
  type ShellPtyProbe
} from "./shellEnvironment";

describe("shell environment resolver", () => {
  let sandboxDir: string;

  beforeAll(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "kmux-shell-env-"));
  });

  afterAll(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("prefers configured shell over inherited and fallback values", () => {
    expect(
      resolveShellPath(
        "/opt/custom/zsh",
        {SHELL: "/bin/bash"},
        "darwin",
        "/bin/fish"
      )
    ).toBe("/opt/custom/zsh");

    expect(
      resolveShellPath(undefined, {SHELL: "/bin/bash"}, "linux", "/bin/fish")
    ).toBe("/bin/bash");

    expect(resolveShellPath(undefined, {}, "darwin", "/bin/fish")).toBe(
      "/bin/fish"
    );

    expect(resolveShellPath(undefined, {}, "darwin", "")).toBe("/bin/zsh");
    expect(resolveShellPath(undefined, {}, "linux", "")).toBe("/bin/bash");
  });

  it("extracts env json between markers even when shell noise surrounds it", () => {
    const env = parseShellEnvOutput(
      "warning\n__MARK__{\"PATH\":\"/usr/local/bin\",\"SHELL\":\"/bin/zsh\"}__MARK__\ntrailer",
      "__MARK__"
    );

    expect(env).toEqual({
      PATH: "/usr/local/bin",
      SHELL: "/bin/zsh"
    });
  });

  it("uses a PTY-backed login interactive probe on macOS and returns resolved env output", async () => {
    let receivedOptions: Parameters<ShellPtyProbe>[0] | null = null;
    const ptyProbe: ShellPtyProbe = vi.fn(async (options) => {
      receivedOptions = options;
      return "shell noise\n__TOKEN__{\"PATH\":\"/usr/local/bin\",\"SHELL\":\"/bin/zsh\"}__TOKEN__";
    });
    const exec: ShellCommandExecutor = vi.fn(async () => {
      throw new Error("exec path should not run on macOS PTY probes");
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1"
      },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      exec,
      ptyProbe
    });

    expect(receivedOptions).not.toBeNull();
    expect(receivedOptions?.shellPath).toBe("/bin/zsh");
    expect(receivedOptions?.args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(receivedOptions?.args[3]).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(receivedOptions?.args[3]).toContain("exec 2>/dev/null");
    expect(receivedOptions?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(receivedOptions?.timeoutMs).toBe(15_000);
    expect(exec).not.toHaveBeenCalled();
    expect(resolved).toEqual({
      shellPath: "/bin/zsh",
      baseEnv: {
        PATH: "/usr/local/bin",
        SHELL: "/bin/zsh"
      },
      source: "resolved"
    });
  });

  it("uses the direct shell invocation path off macOS", async () => {
    let receivedCommand = "";
    let receivedArgs: string[] = [];
    let receivedEnv: NodeJS.ProcessEnv = {};
    const exec: ShellCommandExecutor = vi.fn(async (command, args, options) => {
      receivedCommand = command;
      receivedArgs = args;
      receivedEnv = options.env;
      return {
        stdout:
          "__TOKEN__{\"PATH\":\"/usr/local/bin\",\"SHELL\":\"/bin/zsh\",\"SHLVL\":\"3\"}__TOKEN__",
        stderr: ""
      };
    });
    const ptyProbe: ShellPtyProbe = vi.fn(async () => {
      throw new Error("PTY path should not run off macOS");
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1"
      },
      platform: "linux",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      exec,
      ptyProbe
    });

    expect(receivedCommand).toBe("/bin/zsh");
    expect(receivedArgs.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(receivedArgs[3]).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(receivedEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(ptyProbe).not.toHaveBeenCalled();
    expect(resolved.baseEnv.SHLVL).toBe("3");
  });

  it("keeps shell-provided SHLVL untouched when the PTY probe returns it", async () => {
    const ptyProbe: ShellPtyProbe = vi.fn(async () => {
      return "__TOKEN__{\"PATH\":\"/usr/local/bin\",\"SHELL\":\"/bin/zsh\",\"SHLVL\":\"3\"}__TOKEN__";
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      ptyProbe
    });

    expect(resolved.baseEnv.SHLVL).toBe("3");
  });

  it("falls back to sanitized inherited env when the PTY probe fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveShellEnvironment({
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1"
      },
      platform: "darwin",
      userShell: "/bin/bash",
      ptyProbe: vi.fn(async () => {
        throw new Error("boom");
      })
    });

    expect(resolved.source).toBe("fallback");
    expect(resolved.shellPath).toBe("/bin/bash");
    expect(resolved.baseEnv.PATH).toBe("/usr/bin");
    expect(resolved.baseEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(resolved.baseEnv.SHELL).toBe("/bin/bash");
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("uses powershell-specific probe args when pwsh is configured", () => {
    expect(
      buildShellEnvProbeArgs("/usr/local/bin/pwsh", "/usr/local/bin/node", "x")
    ).toEqual([
      "-Login",
      "-Command",
      expect.stringContaining("$env:ELECTRON_RUN_AS_NODE='1'; & '/usr/local/bin/node' -e '")
    ]);
  });

  it("uses the PTY probe only for darwin POSIX shells", () => {
    expect(shouldUsePtyShellEnvProbe("/bin/zsh", "darwin")).toBe(true);
    expect(shouldUsePtyShellEnvProbe("/bin/bash", "darwin")).toBe(true);
    expect(shouldUsePtyShellEnvProbe("/bin/zsh", "linux")).toBe(false);
    expect(shouldUsePtyShellEnvProbe("/usr/local/bin/pwsh", "darwin")).toBe(
      false
    );
  });

  it("builds a direct shell invocation for non-PTY execution paths", () => {
    expect(
      buildShellEnvProbeInvocation(
        "/bin/zsh",
        "/usr/local/bin/node",
        "__TOKEN__",
        "linux"
      )
    ).toEqual({
      command: "/bin/zsh",
      args: [
        "-i",
        "-l",
        "-c",
        expect.stringContaining("exec 2>/dev/null")
      ]
    });
  });

  it("resolves the packaged PTY worker next to the bundled main output", () => {
    expect(
      resolveShellEnvProbeLaunchOptions(
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
        "production",
        "/Applications/kmux.app/Contents/Resources"
      )
    ).toEqual({
      entry:
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main/shellEnvProbeWorker.js",
      cwd: "/Applications/kmux.app/Contents/Resources",
      execArgv: []
    });
  });

  it("resolves the production PTY worker from out/main when unpackaged", () => {
    expect(
      resolveShellEnvProbeLaunchOptions(
        "/Users/test/kmux/apps/desktop/out/main",
        "production"
      )
    ).toEqual({
      entry: "/Users/test/kmux/apps/desktop/out/main/shellEnvProbeWorker.js",
      cwd: "/Users/test/kmux",
      execArgv: []
    });
  });

  it("resolves the source PTY worker through tsx during development", () => {
    expect(
      resolveShellEnvProbeLaunchOptions(
        "/Users/test/kmux/apps/desktop/src/main",
        "development"
      )
    ).toEqual({
      entry: "/Users/test/kmux/apps/desktop/src/main/shellEnvProbeWorker.ts",
      cwd: "/Users/test/kmux",
      execArgv: ["--import", "tsx"]
    });
  });

  it("persists the resolved environment to the cache path on success", async () => {
    const cachePath = join(sandboxDir, "persist-success.json");
    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
      platform: "linux",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      cachePath,
      exec: vi.fn(async () => ({
        stdout:
          "__TOKEN__{\"PATH\":\"/usr/local/bin\",\"SHELL\":\"/bin/zsh\"}__TOKEN__",
        stderr: ""
      }))
    });

    expect(resolved.source).toBe("resolved");
    const persisted = JSON.parse(readFileSync(cachePath, "utf8")) as {
      shellPath: string;
      baseEnv: Record<string, string>;
      cachedAt: number;
    };
    expect(persisted.shellPath).toBe("/bin/zsh");
    expect(persisted.baseEnv).toEqual({
      PATH: "/usr/local/bin",
      SHELL: "/bin/zsh"
    });
    expect(typeof persisted.cachedAt).toBe("number");
  });

  it("uses the cached environment as fallback when the PTY probe fails", async () => {
    const cachePath = join(sandboxDir, "fallback-cache.json");
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        shellPath: "/bin/zsh",
        baseEnv: {
          PATH: "/opt/homebrew/bin:/usr/local/bin",
          SHELL: "/bin/zsh",
          FOO: "bar"
        },
        cachedAt: eightDaysAgoMs
      })
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      cachePath,
      ptyProbe: vi.fn(async () => {
        throw new Error("boom");
      })
    });

    expect(resolved.source).toBe("cached");
    expect(resolved.shellPath).toBe("/bin/zsh");
    expect(resolved.baseEnv).toEqual({
      PATH: "/opt/homebrew/bin:/usr/local/bin",
      SHELL: "/bin/zsh",
      FOO: "bar"
    });
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("returns fresh cache immediately without probing synchronously on an SWR hit", async () => {
    const cachePath = join(sandboxDir, "swr-hit.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        shellPath: "/bin/zsh",
        baseEnv: {
          PATH: "/cached/path",
          SHELL: "/bin/zsh"
        },
        cachedAt: Date.now()
      })
    );
    const ptyProbe = vi.fn(async () => {
      return "__TOKEN__{\"PATH\":\"/new/path\",\"SHELL\":\"/bin/zsh\"}__TOKEN__";
    });
    let backgroundRevalidation: Promise<void> | null = null;

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe,
      onBackgroundRevalidation: (promise) => {
        backgroundRevalidation = promise;
      }
    });

    expect(resolved.source).toBe("cached");
    expect(resolved.shellPath).toBe("/bin/zsh");
    expect(resolved.baseEnv).toEqual({
      PATH: "/cached/path",
      SHELL: "/bin/zsh"
    });
    expect(backgroundRevalidation).not.toBeNull();
    await backgroundRevalidation;
    expect(ptyProbe).toHaveBeenCalledTimes(1);
    const refreshed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      baseEnv: Record<string, string>;
    };
    expect(refreshed.baseEnv.PATH).toBe("/new/path");
  });

  it("re-probes synchronously when the cached entry is older than the TTL", async () => {
    const cachePath = join(sandboxDir, "swr-stale.json");
    const stalePastMs = Date.now() - 60 * 60 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        shellPath: "/bin/zsh",
        baseEnv: { PATH: "/stale/path", SHELL: "/bin/zsh" },
        cachedAt: stalePastMs
      })
    );
    const execMock = vi.fn(async () => ({
      stdout:
        "__TOKEN__{\"PATH\":\"/fresh/path\",\"SHELL\":\"/bin/zsh\"}__TOKEN__",
      stderr: ""
    }));

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin" },
      platform: "linux",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      cachePath,
      cacheTtlMs: 30 * 60 * 1000,
      exec: execMock
    });

    expect(resolved.source).toBe("resolved");
    expect(resolved.baseEnv.PATH).toBe("/fresh/path");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("ignores cached entries that were recorded for a different shell", async () => {
    const cachePath = join(sandboxDir, "mismatched-shell.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        shellPath: "/bin/bash",
        baseEnv: { PATH: "/bash/only" },
        cachedAt: Date.now()
      })
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
      platform: "darwin",
      cachePath,
      ptyProbe: vi.fn(async () => {
        throw new Error("boom");
      })
    });

    expect(resolved.source).toBe("fallback");
    expect(resolved.baseEnv.PATH).toBe("/usr/bin");
    warning.mockRestore();
  });

  it("falls back when the cache file is malformed", async () => {
    const cachePath = join(sandboxDir, "malformed.json");
    writeFileSync(cachePath, "not json");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      cachePath,
      ptyProbe: vi.fn(async () => {
        throw new Error("boom");
      })
    });

    expect(resolved.source).toBe("fallback");
    warning.mockRestore();
  });
});
