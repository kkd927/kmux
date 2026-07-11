import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  buildShellLaunchPolicy,
  buildShellEnvProbeArgs,
  buildShellEnvProbeInvocation,
  cancelShellEnvironmentRefresh,
  createShellStartupConfigFingerprint,
  parseShellEnvOutput,
  resolveShellEnvironment,
  resolveShellEnvProbeLaunchOptions,
  resolveShellPath,
  shouldUsePtyShellEnvProbe,
  terminateShellEnvProbeProcessTree,
  type ShellCommandExecutor,
  type ShellPtyProbe,
  type ShellPtyProbeOptions
} from "./shellEnvironment";

describe("shell environment resolver", () => {
  let sandboxDir: string;

  beforeAll(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "kmux-shell-env-"));
  });

  afterEach(() => {
    cancelShellEnvironmentRefresh();
  });

  afterAll(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("prefers configured shell over inherited and fallback values", () => {
    expect(
      resolveShellPath(
        "/opt/custom/zsh",
        { SHELL: "/bin/bash" },
        "darwin",
        "/bin/fish"
      )
    ).toBe("/opt/custom/zsh");

    expect(
      resolveShellPath(undefined, { SHELL: "/bin/bash" }, "linux", "/bin/fish")
    ).toBe("/bin/bash");

    expect(resolveShellPath(undefined, {}, "darwin", "/bin/fish")).toBe(
      "/bin/fish"
    );

    expect(resolveShellPath(undefined, {}, "darwin", "")).toBe("/bin/zsh");
    expect(resolveShellPath(undefined, {}, "linux", "")).toBe("/bin/bash");
  });

  it("builds a macOS launch policy with login shell args and shell integration", () => {
    const policy = buildShellLaunchPolicy({
      defaultShellPath: "/bin/zsh",
      platform: "darwin",
      enableShellIntegration: true,
      socketPath: "/tmp/kmux.sock",
      nodePath: "/Applications/kmux.app/Contents/MacOS/kmux",
      agentHookBinDir: "/Users/test/.local/share/kmux/hooks",
      agentWrapperBinDir: "/Users/test/.local/share/kmux/wrappers"
    });

    expect(policy).toEqual({
      defaultShellPath: "/bin/zsh",
      defaultShellArgs: ["-l"],
      stripManagedEnv: true,
      integration: {
        enabled: true,
        mode: "posix-wrapper"
      },
      agentPath: {
        helperBinDir: "/Users/test/.local/share/kmux/hooks",
        wrapperBinDir: "/Users/test/.local/share/kmux/wrappers",
        prependWrapperToPath: true
      },
      hookEnv: {
        KMUX_SOCKET_PATH: "/tmp/kmux.sock",
        KMUX_AGENT_BIN_DIR: "/Users/test/.local/share/kmux/hooks",
        KMUX_NODE_PATH: "/Applications/kmux.app/Contents/MacOS/kmux"
      }
    });
  });

  it("builds a Linux launch policy without shell rc integration", () => {
    const policy = buildShellLaunchPolicy({
      defaultShellPath: "/bin/bash",
      launchShell: "/usr/bin/fish",
      platform: "linux",
      enableShellIntegration: false,
      socketPath: "/run/user/1000/kmux/control.sock",
      nodePath: "/opt/kmux/kmux",
      agentHookBinDir: "/home/test/.local/share/kmux/hooks",
      agentWrapperBinDir: "/home/test/.local/share/kmux/wrappers"
    });

    expect(policy.defaultShellPath).toBe("/usr/bin/fish");
    expect(policy.defaultShellArgs).toEqual([]);
    expect(policy.stripManagedEnv).toBe(false);
    expect(policy.integration).toEqual({
      enabled: false,
      mode: "none"
    });
    expect(policy.hookEnv).toMatchObject({
      KMUX_SOCKET_PATH: "/run/user/1000/kmux/control.sock",
      KMUX_AGENT_BIN_DIR: "/home/test/.local/share/kmux/hooks",
      KMUX_NODE_PATH: "/opt/kmux/kmux"
    });
  });

  it("extracts env json between markers even when shell noise surrounds it", () => {
    const env = parseShellEnvOutput(
      'warning\n__MARK__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh"}__MARK__\ntrailer',
      "__MARK__"
    );

    expect(env).toEqual({
      PATH: "/usr/local/bin",
      SHELL: "/bin/zsh"
    });
  });

  it("uses a PTY-backed login interactive probe on macOS and returns resolved env output", async () => {
    const ptyProbe = vi.fn(async (_options: ShellPtyProbeOptions) => {
      return 'shell noise\n__TOKEN__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh"}__TOKEN__';
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

    const receivedOptions = ptyProbe.mock.calls[0]?.[0];
    expect(receivedOptions).toBeDefined();
    if (!receivedOptions) {
      throw new Error("expected PTY probe options to be captured");
    }
    expect(receivedOptions.shellPath).toBe("/bin/zsh");
    expect(receivedOptions.args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(receivedOptions.args[3]).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(receivedOptions.args[3]).toContain("exec 2>/dev/null");
    expect(receivedOptions.cwd).toBe(process.cwd());
    expect(receivedOptions.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(receivedOptions.env.KMUX_SHELL_ENV_PROBE).toBe("1");
    expect(receivedOptions.env.POWERLEVEL9K_DISABLE_GITSTATUS).toBeUndefined();
    expect(receivedOptions.timeoutMs).toBe(5_000);
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

  it("uses only an absolute HOME as the PTY shell env probe cwd", async () => {
    const ptyProbe = vi.fn(async (_options: ShellPtyProbeOptions) => {
      return '__TOKEN__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh"}__TOKEN__';
    });

    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        HOME: "relative-home",
        PATH: "/usr/bin"
      },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      exec: vi.fn(async () => {
        throw new Error("exec path should not run on macOS PTY probes");
      }),
      ptyProbe
    });

    expect(ptyProbe.mock.calls[0]?.[0].cwd).toBe(process.cwd());

    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        HOME: " /Users/test ",
        PATH: "/usr/bin"
      },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      exec: vi.fn(async () => {
        throw new Error("exec path should not run on macOS PTY probes");
      }),
      ptyProbe
    });

    expect(ptyProbe.mock.calls[1]?.[0].cwd).toBe("/Users/test");
  });

  it("preserves user Powerlevel10k gitstatus preferences from the probe result", async () => {
    const ptyProbe: ShellPtyProbe = vi.fn(async () => {
      return '__TOKEN__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh","KMUX_SHELL_ENV_PROBE":"1","POWERLEVEL9K_DISABLE_GITSTATUS":"true"}__TOKEN__';
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        PATH: "/usr/bin",
        POWERLEVEL9K_DISABLE_GITSTATUS: "true"
      },
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      ptyProbe
    });

    expect(resolved.baseEnv.KMUX_SHELL_ENV_PROBE).toBeUndefined();
    expect(resolved.baseEnv.POWERLEVEL9K_DISABLE_GITSTATUS).toBe("true");
  });

  it("uses the PTY-backed login interactive probe on Linux too", async () => {
    const exec: ShellCommandExecutor = vi.fn(async () => {
      throw new Error("exec path should not run for Linux POSIX shells");
    });
    const ptyProbe: ShellPtyProbe = vi.fn(
      async () =>
        '__TOKEN__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh","SHLVL":"3"}__TOKEN__'
    );

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

    const receivedOptions = vi.mocked(ptyProbe).mock.calls[0]?.[0];
    expect(receivedOptions?.shellPath).toBe("/bin/zsh");
    expect(receivedOptions?.args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(receivedOptions?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(resolved.baseEnv.SHLVL).toBe("3");
  });

  it("keeps shell-provided SHLVL untouched when the PTY probe returns it", async () => {
    const ptyProbe: ShellPtyProbe = vi.fn(async () => {
      return '__TOKEN__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh","SHLVL":"3"}__TOKEN__';
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

  it("does not repeat a foreground delay for the same failed fingerprint on a fresh cache", async () => {
    const home = join(sandboxDir, "fresh-failure-home");
    const cachePath = join(sandboxDir, "fresh-failure-cache.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".zshrc"), "return 1\n");
    const env = {
      HOME: home,
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
      LaunchInstanceID: "launch-one",
      SSH_AUTH_SOCK: "/tmp/agent-one.sock"
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstProbe = vi.fn(async () => {
      throw new Error("probe timed out");
    });

    const first = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      cachePath,
      ptyProbe: firstProbe
    });
    expect(first.source).toBe("fallback");
    expect(firstProbe).toHaveBeenCalledTimes(1);

    const repeatedProbe = vi.fn(async () => {
      throw new Error("must stay off the startup path");
    });
    const repeated = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        ...env,
        LaunchInstanceID: "launch-two",
        SSH_AUTH_SOCK: "/tmp/agent-two.sock"
      },
      platform: "darwin",
      cachePath,
      refreshCachedEnv: false,
      ptyProbe: repeatedProbe
    });
    expect(repeated.source).toBe("cached");
    expect(repeated.baseEnv.PATH).toBe("/usr/bin");
    expect(repeated.baseEnv.LaunchInstanceID).toBe("launch-two");
    expect(repeated.baseEnv.SSH_AUTH_SOCK).toBe("/tmp/agent-two.sock");
    expect(repeatedProbe).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("can skip shell env probing for smoke and gate runs", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: ""
    }));
    const ptyProbe = vi.fn(async () => "");

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
        KMUX_DISABLE_SHELL_ENV_PROBE: "1"
      },
      platform: "darwin",
      exec,
      ptyProbe
    });

    expect(resolved).toEqual({
      shellPath: "/bin/zsh",
      source: "fallback",
      baseEnv: {
        PATH: "/usr/bin",
        SHELL: "/bin/zsh"
      }
    });
    expect(exec).not.toHaveBeenCalled();
    expect(ptyProbe).not.toHaveBeenCalled();
  });

  it("uses powershell-specific probe args when pwsh is configured", () => {
    expect(
      buildShellEnvProbeArgs("/usr/local/bin/pwsh", "/usr/local/bin/node", "x")
    ).toEqual([
      "-Login",
      "-Command",
      expect.stringContaining(
        "$env:ELECTRON_RUN_AS_NODE='1'; & '/usr/local/bin/node' -e '"
      )
    ]);
  });

  it("uses the PTY probe for macOS and Linux POSIX shells", () => {
    expect(shouldUsePtyShellEnvProbe("/bin/zsh", "darwin")).toBe(true);
    expect(shouldUsePtyShellEnvProbe("/bin/bash", "darwin")).toBe(true);
    expect(shouldUsePtyShellEnvProbe("/bin/zsh", "linux")).toBe(true);
    expect(shouldUsePtyShellEnvProbe("/usr/bin/fish", "linux")).toBe(true);
    expect(shouldUsePtyShellEnvProbe("/usr/local/bin/pwsh", "darwin")).toBe(
      false
    );
    expect(shouldUsePtyShellEnvProbe("/usr/bin/pwsh", "linux")).toBe(false);
  });

  it("fingerprints zsh, bash, fish, macOS, and Linux startup inputs", () => {
    const home = join(sandboxDir, "fingerprint-home");
    const zdotdir = join(home, "zdotdir");
    const xdgConfigHome = join(home, "xdg");
    const zsh = createShellStartupConfigFingerprint(
      "/bin/zsh",
      "darwin",
      {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        ZDOTDIR: zdotdir,
        KMUX_SESSION_ID: "ignored-a"
      },
      {}
    );
    const zshWithAnotherSession = createShellStartupConfigFingerprint(
      "/bin/zsh",
      "darwin",
      {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        ZDOTDIR: zdotdir,
        KMUX_SESSION_ID: "ignored-b",
        LaunchInstanceID: "launch-b",
        XPC_SERVICE_NAME: "application.kmux.b",
        SSH_AUTH_SOCK: "/tmp/agent-b.sock"
      },
      {}
    );
    const zshWithLaunchIdentity = createShellStartupConfigFingerprint(
      "/bin/zsh",
      "darwin",
      {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        ZDOTDIR: zdotdir,
        KMUX_SESSION_ID: "ignored-a",
        LaunchInstanceID: "launch-a",
        XPC_SERVICE_NAME: "application.kmux.a",
        SSH_AUTH_SOCK: "/tmp/agent-a.sock"
      },
      {}
    );
    const bash = createShellStartupConfigFingerprint(
      "/bin/bash",
      "linux",
      { HOME: home, PATH: "/usr/bin", SHELL: "/bin/bash" },
      {}
    );
    const fish = createShellStartupConfigFingerprint(
      "/usr/bin/fish",
      "linux",
      {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/usr/bin/fish",
        XDG_CONFIG_HOME: xdgConfigHome
      },
      {}
    );

    expect(zsh?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        join(home, ".zshenv"),
        join(zdotdir, ".zshrc"),
        "/etc/zshrc",
        "/etc/paths"
      ])
    );
    expect(zshWithAnotherSession?.inheritedEnvHash).toBe(zsh?.inheritedEnvHash);
    expect(zshWithLaunchIdentity?.inheritedEnvHash).toBe(
      zshWithAnotherSession?.inheritedEnvHash
    );
    expect(bash?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        join(home, ".bash_profile"),
        join(home, ".bashrc"),
        "/etc/environment",
        "/etc/profile"
      ])
    );
    expect(fish?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        join(xdgConfigHome, "fish", "config.fish"),
        "/etc/fish/config.fish",
        "/etc/environment"
      ])
    );
  });

  it("kills both the PTY and worker process groups on probe timeout cleanup", () => {
    const killProcess = vi.fn(() => true as const);
    const child = {
      pid: 101,
      kill: vi.fn(() => true)
    };

    terminateShellEnvProbeProcessTree(child, 202, "SIGKILL", killProcess);

    expect(killProcess.mock.calls).toEqual([
      [-202, "SIGKILL"],
      [-101, "SIGKILL"]
    ]);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("builds a direct shell invocation for non-PTY execution paths", () => {
    expect(
      buildShellEnvProbeInvocation(
        "/bin/zsh",
        "/usr/local/bin/node",
        "__TOKEN__",
        "freebsd"
      )
    ).toEqual({
      command: "/bin/zsh",
      args: ["-i", "-l", "-c", expect.stringContaining("exec 2>/dev/null")]
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
      cwd: "/Applications/kmux.app/Contents/Resources/app.asar.unpacked",
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
      ptyProbe: vi.fn(
        async () =>
          '__TOKEN__{"PATH":"/usr/local/bin","SHELL":"/bin/zsh"}__TOKEN__'
      )
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

  it("returns a same-shell cache immediately when the startup fingerprint is unchanged", async () => {
    const home = join(sandboxDir, "unchanged-home");
    const cachePath = join(sandboxDir, "unchanged-cache.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".zshrc"), "export FROM_RC=one\n");
    const env = { HOME: home, PATH: "/usr/bin", SHELL: "/bin/zsh" };

    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      processExecPath: "/usr/local/bin/node",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: vi.fn(
        async () =>
          '__TOKEN__{"HOME":' +
          JSON.stringify(home) +
          ',"PATH":"/cached/path","SHELL":"/bin/zsh"}__TOKEN__'
      )
    });
    const blockingProbe = vi.fn(
      async () => await new Promise<string>(() => undefined)
    );

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      cachePath,
      refreshCachedEnv: false,
      ptyProbe: blockingProbe
    });

    expect(resolved.source).toBe("cached");
    expect(resolved.baseEnv.PATH).toBe("/cached/path");
    expect(blockingProbe).not.toHaveBeenCalled();
  });

  it("takes volatile and KMUX runtime values from the current launch on a cache hit", async () => {
    const home = join(sandboxDir, "runtime-overlay-home");
    const cachePath = join(sandboxDir, "runtime-overlay-cache.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".zshrc"), "export READY=1\n");
    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        DISPLAY: ":old",
        LaunchInstanceID: "launch-old",
        SSH_AUTH_SOCK: "/tmp/agent-old.sock",
        XPC_SERVICE_NAME: "application.kmux.old",
        KMUX_PROFILE_LOG_PATH: "/tmp/old-profile"
      },
      platform: "darwin",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: vi.fn(
        async () =>
          `__TOKEN__${JSON.stringify({
            HOME: home,
            PATH: "/shell/path",
            SHELL: "/bin/zsh",
            DISPLAY: ":old",
            LaunchInstanceID: "launch-old",
            SSH_AUTH_SOCK: "/tmp/agent-old.sock",
            XPC_SERVICE_NAME: "application.kmux.old",
            KMUX_PROFILE_LOG_PATH: "/tmp/old-profile"
          })}__TOKEN__`
      )
    });
    const blockingProbe = vi.fn(
      async () => await new Promise<string>(() => undefined)
    );

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        DISPLAY: ":new",
        LaunchInstanceID: "launch-new",
        SSH_AUTH_SOCK: "/tmp/agent-new.sock",
        XPC_SERVICE_NAME: "application.kmux.new",
        KMUX_PROFILE_LOG_PATH: "/tmp/new-profile"
      },
      platform: "darwin",
      cachePath,
      refreshCachedEnv: false,
      ptyProbe: blockingProbe
    });

    expect(resolved.source).toBe("cached");
    expect(resolved.baseEnv.PATH).toBe("/shell/path");
    expect(resolved.baseEnv.DISPLAY).toBe(":new");
    expect(resolved.baseEnv.LaunchInstanceID).toBe("launch-new");
    expect(resolved.baseEnv.SSH_AUTH_SOCK).toBe("/tmp/agent-new.sock");
    expect(resolved.baseEnv.XPC_SERVICE_NAME).toBe("application.kmux.new");
    expect(resolved.baseEnv.KMUX_PROFILE_LOG_PATH).toBe("/tmp/new-profile");
    expect(blockingProbe).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(cachePath, "utf8")) as {
      baseEnv: Record<string, string>;
    };
    expect(persisted.baseEnv.KMUX_PROFILE_LOG_PATH).toBeUndefined();
  });

  it("takes Linux desktop and login-session endpoints from the current launch on a cache hit", async () => {
    const home = join(sandboxDir, "linux-runtime-overlay-home");
    const cachePath = join(sandboxDir, "linux-runtime-overlay-cache.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".bashrc"), "export READY=1\n");
    await resolveShellEnvironment({
      preferredShell: "/bin/bash",
      env: {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/bash",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus-old",
        WAYLAND_DISPLAY: "wayland-old",
        XAUTHORITY: "/run/user/1000/xauth-old",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_SESSION_ID: "old-session"
      },
      platform: "linux",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: vi.fn(
        async () =>
          `__TOKEN__${JSON.stringify({
            HOME: home,
            PATH: "/shell/path",
            SHELL: "/bin/bash",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus-old",
            WAYLAND_DISPLAY: "wayland-old",
            XAUTHORITY: "/run/user/1000/xauth-old",
            XDG_RUNTIME_DIR: "/run/user/1000",
            XDG_SESSION_ID: "old-session"
          })}__TOKEN__`
      )
    });
    const unexpectedProbe = vi.fn(async () => {
      throw new Error("session endpoints must not invalidate the cache");
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/bash",
      env: {
        HOME: home,
        PATH: "/usr/bin",
        SHELL: "/bin/bash",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus-new",
        WAYLAND_DISPLAY: "wayland-new",
        XAUTHORITY: "/run/user/1000/xauth-new",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_SESSION_ID: "new-session"
      },
      platform: "linux",
      cachePath,
      refreshCachedEnv: false,
      ptyProbe: unexpectedProbe
    });

    expect(resolved.source).toBe("cached");
    expect(resolved.baseEnv.PATH).toBe("/shell/path");
    expect(resolved.baseEnv.DBUS_SESSION_BUS_ADDRESS).toBe(
      "unix:path=/run/user/1000/bus-new"
    );
    expect(resolved.baseEnv.WAYLAND_DISPLAY).toBe("wayland-new");
    expect(resolved.baseEnv.XAUTHORITY).toBe("/run/user/1000/xauth-new");
    expect(resolved.baseEnv.XDG_SESSION_ID).toBe("new-session");
    expect(unexpectedProbe).not.toHaveBeenCalled();
  });

  it("forces a bounded fresh probe when .zshrc content changes", async () => {
    const home = join(sandboxDir, "changed-home");
    const cachePath = join(sandboxDir, "changed-cache.json");
    mkdirSync(home, { recursive: true });
    const zshrc = join(home, ".zshrc");
    writeFileSync(zshrc, "export FROM_RC=one\n");
    const env = { HOME: home, PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: vi.fn(
        async () =>
          `__TOKEN__${JSON.stringify({ HOME: home, PATH: "/old/path", SHELL: "/bin/zsh" })}__TOKEN__`
      )
    });
    writeFileSync(zshrc, "export FROM_RC=two\n");
    const freshProbe = vi.fn(
      async () =>
        `__TOKEN__${JSON.stringify({ HOME: home, PATH: "/new/path", SHELL: "/bin/zsh" })}__TOKEN__`
    );

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: freshProbe
    });

    expect(resolved.source).toBe("resolved");
    expect(resolved.baseEnv.PATH).toBe("/new/path");
    expect(freshProbe).toHaveBeenCalledTimes(1);
    const refreshed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      schemaVersion: number;
      baseEnv: Record<string, string>;
      startupConfigFingerprint: {
        files: Array<{ path: string; sha256?: string }>;
      };
    };
    expect(refreshed.schemaVersion).toBe(2);
    expect(refreshed.baseEnv.PATH).toBe("/new/path");
    expect(
      refreshed.startupConfigFingerprint.files.find(
        (file) => file.path === zshrc
      )?.sha256
    ).toEqual(expect.any(String));
  });

  it("uses a prior same-shell cache only as fallback when refresh fails", async () => {
    const home = join(sandboxDir, "failed-refresh-home");
    const cachePath = join(sandboxDir, "failed-refresh-cache.json");
    mkdirSync(home, { recursive: true });
    const zshrc = join(home, ".zshrc");
    writeFileSync(zshrc, "export FROM_RC=old\n");
    const env = { HOME: home, PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: vi.fn(
        async () =>
          `__TOKEN__${JSON.stringify({ HOME: home, PATH: "/last/known/path", SHELL: "/bin/zsh" })}__TOKEN__`
      )
    });
    const lastKnownGood = JSON.parse(readFileSync(cachePath, "utf8")) as {
      startupConfigFingerprint: unknown;
    };
    writeFileSync(zshrc, "export FROM_RC=new\n");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failedProbe = vi.fn(async () => {
      throw new Error("probe timed out");
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      cachePath,
      ptyProbe: failedProbe
    });

    expect(failedProbe).toHaveBeenCalledTimes(1);
    expect(resolved.source).toBe("cached");
    expect(resolved.baseEnv.PATH).toBe("/last/known/path");
    expect(warning).toHaveBeenCalled();
    const failedRefresh = JSON.parse(readFileSync(cachePath, "utf8")) as {
      startupConfigFingerprint?: unknown;
      lastProbeFailure?: { fingerprint?: unknown; failedAt?: number };
    };
    expect(failedRefresh.startupConfigFingerprint).toEqual(
      lastKnownGood.startupConfigFingerprint
    );
    expect(failedRefresh.lastProbeFailure?.fingerprint).toBeDefined();
    expect(failedRefresh.lastProbeFailure?.fingerprint).not.toEqual(
      failedRefresh.startupConfigFingerprint
    );
    expect(failedRefresh.lastProbeFailure?.failedAt).toEqual(
      expect.any(Number)
    );

    const backgroundProbe = vi.fn(
      async () =>
        `__TOKEN__${JSON.stringify({ HOME: home, PATH: "/fresh/path", SHELL: "/bin/zsh" })}__TOKEN__`
    );
    const repeated = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      cachePath,
      randomToken: "__TOKEN__",
      ptyProbe: backgroundProbe
    });
    expect(repeated.source).toBe("cached");
    expect(repeated.baseEnv.PATH).toBe("/last/known/path");
    await vi.waitFor(() => {
      const refreshed = JSON.parse(readFileSync(cachePath, "utf8")) as {
        baseEnv: Record<string, string>;
        lastProbeFailure?: unknown;
      };
      expect(refreshed.baseEnv.PATH).toBe("/fresh/path");
      expect(refreshed.lastProbeFailure).toBeUndefined();
    });
    expect(backgroundProbe).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("probes before using a safely parsed legacy same-shell cache fallback", async () => {
    const cachePath = join(sandboxDir, "legacy-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        shellPath: "/bin/zsh",
        baseEnv: { PATH: "/legacy/path", SHELL: "/bin/zsh" },
        cachedAt: Date.now()
      })
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failedProbe = vi.fn(async () => {
      throw new Error("probe failed");
    });

    const resolved = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { HOME: sandboxDir, PATH: "/usr/bin", SHELL: "/bin/zsh" },
      platform: "darwin",
      cachePath,
      ptyProbe: failedProbe
    });

    expect(failedProbe).toHaveBeenCalledTimes(1);
    expect(resolved.source).toBe("cached");
    expect(resolved.baseEnv.PATH).toBe("/legacy/path");
    const upgraded = JSON.parse(readFileSync(cachePath, "utf8")) as {
      schemaVersion: number;
      platform: string;
      startupConfigFingerprint?: unknown;
      lastProbeFailure?: { fingerprint?: unknown };
    };
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.platform).toBe("darwin");
    expect(upgraded.startupConfigFingerprint).toBeUndefined();
    expect(upgraded.lastProbeFailure?.fingerprint).toBeDefined();

    const repeatedProbe = vi.fn(async () => {
      throw new Error("must not block startup again");
    });
    const repeated = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env: { HOME: sandboxDir, PATH: "/usr/bin", SHELL: "/bin/zsh" },
      platform: "darwin",
      cachePath,
      refreshCachedEnv: false,
      ptyProbe: repeatedProbe
    });
    expect(repeated.source).toBe("cached");
    expect(repeated.baseEnv.PATH).toBe("/legacy/path");
    expect(repeatedProbe).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("runs at most one cached-env refresh and aborts it on shutdown", async () => {
    const home = join(sandboxDir, "refresh-home");
    const cachePath = join(sandboxDir, "refresh-cache.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".zshrc"), "export READY=1\n");
    const env = { HOME: home, PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      randomToken: "__TOKEN__",
      cachePath,
      ptyProbe: vi.fn(
        async () =>
          `__TOKEN__${JSON.stringify({ HOME: home, PATH: "/cached/path", SHELL: "/bin/zsh" })}__TOKEN__`
      )
    });
    let aborted = false;
    const refreshProbe = vi.fn(
      async (options: ShellPtyProbeOptions) =>
        await new Promise<string>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true }
          );
        })
    );

    const first = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      cachePath,
      ptyProbe: refreshProbe
    });
    const second = await resolveShellEnvironment({
      preferredShell: "/bin/zsh",
      env,
      platform: "darwin",
      cachePath,
      ptyProbe: refreshProbe
    });
    expect(first.source).toBe("cached");
    expect(second.source).toBe("cached");
    expect(refreshProbe).toHaveBeenCalledTimes(1);

    cancelShellEnvironmentRefresh();
    await vi.waitFor(() => expect(aborted).toBe(true));
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
