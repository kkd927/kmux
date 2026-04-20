import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";

import {
  buildShellEnvProbeArgs,
  parseShellEnvOutput,
  resolveShellEnvironment,
  resolveShellPath,
  type ShellCommandExecutor
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

  it("uses a login interactive probe and returns resolved env output", async () => {
    let receivedArgs: string[] = [];
    let receivedEnv: NodeJS.ProcessEnv = {};
    const exec: ShellCommandExecutor = vi.fn(async (_command, args, options) => {
      receivedArgs = args;
      receivedEnv = options.env;
      return {
        stdout:
          "shell noise\n__TOKEN__{\"PATH\":\"/usr/local/bin\",\"SHELL\":\"/bin/zsh\"}__TOKEN__",
        stderr: ""
      };
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1"
      },
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      exec
    });

    expect(receivedArgs.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(receivedArgs[3]).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(receivedEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(resolved).toEqual({
      shellPath: "/bin/zsh",
      baseEnv: {
        PATH: "/usr/local/bin",
        SHELL: "/bin/zsh"
      },
      source: "resolved"
    });
  });

  it("falls back to sanitized inherited env when probe execution fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveShellEnvironment({
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1"
      },
      platform: "darwin",
      userShell: "/bin/bash",
      exec: vi.fn(async () => {
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

  it("persists the resolved environment to the cache path on success", async () => {
    const cachePath = join(sandboxDir, "persist-success.json");
    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
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

  it("uses the cached environment as fallback when the probe fails", async () => {
    const cachePath = join(sandboxDir, "fallback-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        shellPath: "/bin/zsh",
        baseEnv: {
          PATH: "/opt/homebrew/bin:/usr/local/bin",
          SHELL: "/bin/zsh",
          FOO: "bar"
        },
        cachedAt: Date.now()
      })
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
      processExecPath: "/usr/local/bin/node",
      cachePath,
      exec: vi.fn(async () => {
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
      cachePath,
      exec: vi.fn(async () => {
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
      cachePath,
      exec: vi.fn(async () => {
        throw new Error("boom");
      })
    });

    expect(resolved.source).toBe("fallback");
    warning.mockRestore();
  });
});
