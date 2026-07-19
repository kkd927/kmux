import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState, encodeAppStateDto } from "@kmux/core";

import {
  AppPathResolutionError,
  createSettingsStore,
  createSnapshotStore,
  resolveAppPaths,
  createWindowStateStore,
  type PersistedWindowState
} from "./index";

describe("file-store persistence", () => {
  let sandboxDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "kmux-persistence-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(sandboxDir, { force: true, recursive: true });
  });

  it("roundtrips state snapshots with versioned envelopes", () => {
    const statePath = join(sandboxDir, "state.json");
    const store = createSnapshotStore(statePath);
    const state = createInitialState("/bin/zsh");

    store.save(state);

    expect(store.load()).toEqual(state);
    expect(store.loadRecord()).toEqual({
      snapshot: state,
      cleanShutdown: false,
      restoreOnLaunch: false
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 2,
      cleanShutdown: false,
      restoreOnLaunch: false,
      snapshot: encodeAppStateDto(state)
    });
  });

  it("persists clean shutdown metadata on the final snapshot save", () => {
    const statePath = join(sandboxDir, "state-clean.json");
    const store = createSnapshotStore(statePath);
    const state = createInitialState("/bin/zsh");

    store.save(state, { cleanShutdown: true });

    expect(store.load()).toEqual(state);
    expect(store.loadRecord()).toEqual({
      snapshot: state,
      cleanShutdown: true,
      restoreOnLaunch: false
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 2,
      cleanShutdown: true,
      restoreOnLaunch: false,
      snapshot: encodeAppStateDto(state)
    });
  });

  it("force-writes a private replacement snapshot for conversion recovery", () => {
    const statePath = join(sandboxDir, "state-durable.json");
    const store = createSnapshotStore(statePath);
    const state = createInitialState("/bin/zsh");

    store.saveDurable(state, { cleanShutdown: false });

    expect(store.load()).toEqual(state);
    expect(lstatSync(statePath).isFile()).toBe(true);
    expect(lstatSync(statePath).mode & 0o077).toBe(0);
    expect(
      readFileSync(statePath, "utf8").includes(".snapshot.tmp")
    ).toBe(false);
  });

  it("persists normal quit restore metadata on the final snapshot save", () => {
    const statePath = join(sandboxDir, "state-restore-on-launch.json");
    const store = createSnapshotStore(statePath);
    const state = createInitialState("/bin/zsh");

    store.save(state, { cleanShutdown: true, restoreOnLaunch: true });

    expect(store.loadRecord()).toEqual({
      snapshot: state,
      cleanShutdown: true,
      restoreOnLaunch: true
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 2,
      cleanShutdown: true,
      restoreOnLaunch: true,
      snapshot: encodeAppStateDto(state)
    });
  });

  it("roundtrips window state with versioned envelopes", () => {
    const windowStatePath = join(sandboxDir, "window-state.json");
    const store = createWindowStateStore(windowStatePath);
    const windowState: PersistedWindowState = {
      width: 1440,
      height: 960,
      x: 20,
      y: 30,
      maximized: false,
      sidebarVisible: false,
      sidebarWidth: 280
    };

    store.save(windowState);

    expect(store.load()).toEqual(windowState);
    expect(JSON.parse(readFileSync(windowStatePath, "utf8"))).toEqual({
      version: 1,
      windowState
    });
  });

  it("roundtrips settings without envelopes", () => {
    const settingsPath = join(sandboxDir, "settings.json");
    const store = createSettingsStore(settingsPath);
    const settings = createInitialState("/bin/zsh").settings;

    store.save(settings);

    expect(store.load()).toEqual(settings);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(settings);
  });

  it("does not overwrite settings.json edits made after the app opens the file", () => {
    const settingsPath = join(sandboxDir, "settings.json");
    const store = createSettingsStore(settingsPath);
    const settings = createInitialState("/bin/zsh").settings;
    settings.terminalTypography.preferredTextFontFamily =
      '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace';

    store.save(settings);

    const externallyEditedSettings = {
      ...settings
    } as Record<string, unknown>;
    delete externallyEditedSettings.terminalTypography;
    writeFileSync(
      settingsPath,
      JSON.stringify(externallyEditedSettings, null, 2)
    );

    store.save(settings);

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).not.toHaveProperty(
      "terminalTypography"
    );
  });

  it("skips settings saves when an existing settings.json cannot be read", () => {
    const settingsPath = join(sandboxDir, "settings-unreadable.json");
    const existingSettings = createInitialState("/bin/zsh").settings;
    existingSettings.warnBeforeQuit = false;
    writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));
    chmodSync(settingsPath, 0o000);

    const store = createSettingsStore(settingsPath);
    const nextSettings = createInitialState("/bin/zsh").settings;
    nextSettings.warnBeforeQuit = true;

    store.save(nextSettings);

    chmodSync(settingsPath, 0o600);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(
      existingSettings
    );
  });

  it("strips legacy startupRestore settings when loading from disk", () => {
    const settingsPath = join(sandboxDir, "legacy-settings.json");
    const settings = createInitialState("/bin/zsh")
      .settings as unknown as Record<string, unknown>;

    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...settings,
        startupRestore: false
      })
    );

    const restored = createSettingsStore(settingsPath).load() as Record<
      string,
      unknown
    > | null;

    expect(restored).not.toBeNull();
    expect(restored?.warnBeforeQuit).toBe(settings.warnBeforeQuit);
    expect("startupRestore" in (restored ?? {})).toBe(false);
  });

  it("returns null when files are missing", () => {
    expect(
      createSnapshotStore(join(sandboxDir, "missing-state.json")).load()
    ).toBeNull();
    expect(
      createWindowStateStore(
        join(sandboxDir, "missing-window-state.json")
      ).load()
    ).toBeNull();
    expect(
      createSettingsStore(join(sandboxDir, "missing-settings.json")).load()
    ).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null and warns on invalid JSON", () => {
    const statePath = join(sandboxDir, "state.json");
    writeFileSync(statePath, "{");

    expect(createSnapshotStore(statePath).load()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignoring"));
  });

  it("returns null and warns on unsupported envelope versions", () => {
    const statePath = join(sandboxDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 99,
        snapshot: createInitialState("/bin/zsh")
      })
    );

    expect(createSnapshotStore(statePath).load()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported version 99")
    );
  });

  it("overwrites existing snapshot files atomically", () => {
    const statePath = join(sandboxDir, "state.json");
    const store = createSnapshotStore(statePath);
    const firstState = createInitialState("/bin/zsh");
    const secondState = createInitialState("/bin/bash");

    store.save(firstState);
    store.save(secondState);

    expect(store.load()).toEqual(secondState);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 2,
      cleanShutdown: false,
      restoreOnLaunch: false,
      snapshot: encodeAppStateDto(secondState)
    });
  });

  it("roundtrips usage history with a versioned envelope", async () => {
    const usageHistoryPath = join(sandboxDir, "usage-history.json");
    const persistenceModule = (await import("./index")) as {
      createUsageHistoryStore?: (
        path: string,
        pricingRevision?: string
      ) => {
        load(): unknown;
        save(value: unknown): void;
      };
    };

    expect(typeof persistenceModule.createUsageHistoryStore).toBe("function");

    const store = persistenceModule.createUsageHistoryStore!(
      usageHistoryPath,
      "pricing-revision-a"
    );
    const days = [
      {
        dayKey: "2026-04-15",
        totalCostUsd: 2.4,
        reportedCostUsd: 1.6,
        estimatedCostUsd: 0.8,
        unknownCostTokens: 320,
        totalTokens: 2480,
        vendors: [
          {
            vendor: "claude",
            totalCostUsd: 1.9,
            totalTokens: 1880
          },
          {
            vendor: "codex",
            totalCostUsd: 0.5,
            totalTokens: 600
          }
        ]
      }
    ];

    store.save(days);

    expect(store.load()).toEqual(days);
    expect(JSON.parse(readFileSync(usageHistoryPath, "utf8"))).toEqual({
      version: 1,
      pricingRevision: "pricing-revision-a",
      days
    });
  });

  it("treats usage history as stale when the pricing revision changes", async () => {
    const usageHistoryPath = join(
      sandboxDir,
      "usage-history-pricing-revision.json"
    );
    const persistenceModule = (await import("./index")) as {
      createUsageHistoryStore?: (
        path: string,
        pricingRevision?: string
      ) => {
        load(): unknown;
        save(value: unknown): void;
      };
    };

    expect(typeof persistenceModule.createUsageHistoryStore).toBe("function");

    const initialStore = persistenceModule.createUsageHistoryStore!(
      usageHistoryPath,
      "pricing-revision-a"
    );
    const days = [
      {
        dayKey: "2026-04-16",
        totalCostUsd: 4.2,
        reportedCostUsd: 3.1,
        estimatedCostUsd: 1.1,
        unknownCostTokens: 0,
        totalTokens: 4200,
        vendors: []
      }
    ];
    initialStore.save(days);

    const repricedStore = persistenceModule.createUsageHistoryStore!(
      usageHistoryPath,
      "pricing-revision-b"
    );

    expect(repricedStore.load()).toEqual([]);
  });

  it("treats usage history as stale when the aggregation revision changes", async () => {
    const usageHistoryPath = join(
      sandboxDir,
      "usage-history-aggregation-revision.json"
    );
    const persistenceModule = (await import("./index")) as {
      createUsageHistoryStore?: (
        path: string,
        pricingRevision?: string,
        aggregationRevision?: string
      ) => {
        load(): unknown;
        save(value: unknown): void;
      };
    };

    expect(typeof persistenceModule.createUsageHistoryStore).toBe("function");

    const initialStore = persistenceModule.createUsageHistoryStore!(
      usageHistoryPath,
      "pricing-revision-a",
      "aggregation-revision-a"
    );
    initialStore.save([
      {
        dayKey: "2026-07-12",
        totalCostUsd: 0,
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 100,
        totalTokens: 100,
        vendors: []
      }
    ]);

    const correctedStore = persistenceModule.createUsageHistoryStore!(
      usageHistoryPath,
      "pricing-revision-a",
      "aggregation-revision-b"
    );
    expect(correctedStore.load()).toEqual([]);
  });

  it("returns the dedicated usage history path in the default app paths", async () => {
    const configDir = join(sandboxDir, "config");
    const runtimeDir = join(sandboxDir, "runtime");
    const { defaultAppPaths } = await import("./index");

    const paths = defaultAppPaths("/Users/example", {
      KMUX_CONFIG_DIR: configDir,
      KMUX_RUNTIME_DIR: runtimeDir
    });

    expect(paths.usageHistoryPath).toBe(
      process.platform === "linux"
        ? join(
            "/Users/example",
            ".local",
            "state",
            "kmux",
            "usage-history.json"
          )
        : join(configDir, "usage-history.json")
    );
  });

  it("returns the dedicated shell env cache path in the default app paths", async () => {
    const configDir = join(sandboxDir, "config");
    const runtimeDir = join(sandboxDir, "runtime");
    const { defaultAppPaths } = await import("./index");

    const paths = defaultAppPaths("/Users/example", {
      KMUX_CONFIG_DIR: configDir,
      KMUX_RUNTIME_DIR: runtimeDir
    });

    expect(paths.shellEnvCachePath).toBe(
      process.platform === "linux"
        ? join("/Users/example", ".local", "state", "kmux", "shell-env.json")
        : join(configDir, "shell-env.json")
    );
  });
});

describe("resolveAppPaths", () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "kmux-paths-"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { force: true, recursive: true });
  });

  it("keeps macOS config and runtime defaults compatible", () => {
    const paths = resolveAppPaths({
      homeDir: "/Users/example",
      env: {},
      platform: "darwin",
      tmpDir: "/tmp",
      uid: 501
    });

    expect(paths.configDir).toBe("/Users/example/.config/kmux");
    expect(paths.runtimeDir).toBe("/Users/example/.kmux");
    expect(paths.socketPath).toBe("/Users/example/.kmux/control.sock");
    expect(paths.settingsPath).toBe(
      "/Users/example/.config/kmux/settings.json"
    );
    expect(paths.captureRoot).toBe("/Users/example/.kmux/captures");
    expect(paths.attachmentRoot).toBe("/Users/example/.kmux/attachments");
  });

  it("resolves CLI and desktop paths from the same explicit runtime override", () => {
    const configDir = join(sandboxDir, "config");
    const runtimeDir = join(sandboxDir, "runtime");
    const env = {
      KMUX_CONFIG_DIR: configDir,
      KMUX_RUNTIME_DIR: runtimeDir
    };

    const desktopPaths = resolveAppPaths({
      homeDir: "/Users/example",
      env,
      platform: "darwin"
    });
    const cliPaths = resolveAppPaths({
      homeDir: "/Users/example",
      env,
      platform: "darwin"
    });

    expect(cliPaths.socketPath).toBe(desktopPaths.socketPath);
    expect(cliPaths.socketPath).toBe(join(runtimeDir, "control.sock"));
  });

  it("is side-effect-free for absent path roots", () => {
    const configDir = join(sandboxDir, "missing-config");
    const runtimeDir = join(sandboxDir, "missing-runtime");

    const paths = resolveAppPaths({
      homeDir: "/Users/example",
      env: {
        KMUX_CONFIG_DIR: configDir,
        KMUX_RUNTIME_DIR: runtimeDir
      },
      platform: "darwin"
    });

    expect(paths.settingsPath).toBe(join(configDir, "settings.json"));
    expect(paths.socketPath).toBe(join(runtimeDir, "control.sock"));
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it("uses Linux XDG roots without placing app storage under runtime", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_STATE_HOME: "/xdg/state",
        XDG_DATA_HOME: "/xdg/data",
        XDG_CACHE_HOME: "/xdg/cache"
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000
    });

    expect(paths.configDir).toBe("/xdg/config/kmux");
    expect(paths.runtimeDir).toBe("/run/user/1000/kmux");
    expect(paths.socketPath).toBe("/run/user/1000/kmux/control.sock");
    expect(paths.statePath).toBe("/xdg/state/kmux/state.json");
    expect(paths.usageHistoryPath).toBe("/xdg/state/kmux/usage-history.json");
    expect(paths.desktopInstallationIdentityPath).toBe(
      "/xdg/state/kmux/remote/desktop-installation.json"
    );
    expect(paths.sshProfilesPath).toBe(
      "/xdg/config/kmux/ssh-connections.json"
    );
    expect(paths.remoteTargetBindingsPath).toBe(
      "/xdg/state/kmux/remote/target-bindings.json"
    );
    expect(paths.remoteOperationRoot).toBe("/xdg/state/kmux/remote/operations");
    expect(paths.conversionWalRoot).toBe(
      "/xdg/state/kmux/remote/conversions"
    );
    expect(paths.retainedSessionInventoryPath).toBe(
      "/xdg/state/kmux/remote/retained-sessions.json"
    );
    expect(paths.captureRoot).toBe("/xdg/state/kmux/captures");
    expect(paths.attachmentRoot).toBe("/xdg/data/kmux/attachments");
    expect(paths.nativeCacheRoot).toBe("/xdg/cache/kmux/native");
  });

  it("uses a safe /run/user runtime base when XDG_RUNTIME_DIR is absent", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {},
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000,
      statRuntimeDir: (path) =>
        path === "/run/user/1000"
          ? {
              isDirectory: true,
              isSymbolicLink: false,
              uid: 1000,
              mode: 0o40700
            }
          : null
    });

    expect(paths.runtimeDir).toBe("/run/user/1000/kmux");
    expect(paths.socketPath).toBe("/run/user/1000/kmux/control.sock");
    expect(paths.sources.runtimeDir).toBe("run-user");
  });

  it("falls back to private tmp runtime when /run/user is unsafe", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {},
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000,
      statRuntimeDir: () => ({
        isDirectory: true,
        isSymbolicLink: false,
        uid: 2000,
        mode: 0o40777
      })
    });

    expect(paths.runtimeDir).toBe("/tmp/kmux-runtime-1000");
    expect(paths.socketPath).toBe("/tmp/kmux-runtime-1000/control.sock");
    expect(paths.sources.runtimeDir).toBe("tmp-fallback");
  });

  it("resolves the same Linux socket path for CLI and desktop cases", () => {
    const cases = [
      {
        name: "default",
        env: {},
        expectedSocketPath: "/tmp/kmux-runtime-1000/control.sock"
      },
      {
        name: "xdg",
        env: {
          XDG_RUNTIME_DIR: "/run/user/1000"
        },
        expectedSocketPath: "/run/user/1000/kmux/control.sock"
      },
      {
        name: "explicit",
        env: {
          KMUX_RUNTIME_DIR: "/profiles/kmux/runtime"
        },
        expectedSocketPath: "/profiles/kmux/runtime/control.sock"
      }
    ];

    for (const testCase of cases) {
      const desktopPaths = resolveAppPaths({
        homeDir: "/home/example",
        env: testCase.env,
        platform: "linux",
        tmpDir: "/tmp",
        uid: 1000,
        statRuntimeDir: () => null
      });
      const cliPaths = resolveAppPaths({
        homeDir: "/home/example",
        env: testCase.env,
        platform: "linux",
        tmpDir: "/tmp",
        uid: 1000,
        statRuntimeDir: () => null
      });

      expect(`${testCase.name}:${cliPaths.socketPath}`).toBe(
        `${testCase.name}:${desktopPaths.socketPath}`
      );
      expect(cliPaths.socketPath).toBe(testCase.expectedSocketPath);
    }
  });

  it("falls back to a short socket path when a default runtime path is too long", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        XDG_RUNTIME_DIR: join("/", "tmp", "x".repeat(120))
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000
    });

    expect(paths.sources.socketPath).toBe("path-length-fallback");
    expect(paths.sources.runtimeDir).toBe("path-length-fallback");
    expect(paths.runtimeDir).toMatch(/^\/tmp\/kmux-1000-[0-9a-f]{8}$/);
    expect(paths.socketPath).toBe(`${paths.runtimeDir}/c.sock`);
  });

  it("honors explicit Linux state, data, and cache roots independently", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        KMUX_STATE_DIR: "/profiles/kmux/state",
        KMUX_DATA_DIR: "/profiles/kmux/data",
        KMUX_CACHE_DIR: "/profiles/kmux/cache"
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000
    });

    expect(paths.statePath).toBe("/profiles/kmux/state/state.json");
    expect(paths.usageHistoryPath).toBe(
      "/profiles/kmux/state/usage-history.json"
    );
    expect(paths.shellEnvCachePath).toBe("/profiles/kmux/state/shell-env.json");
    expect(paths.antigravitySessionsPath).toBe(
      "/profiles/kmux/state/antigravity-sessions.json"
    );
    expect(paths.desktopInstallationIdentityPath).toBe(
      "/profiles/kmux/state/remote/desktop-installation.json"
    );
    expect(paths.remoteTargetBindingsPath).toBe(
      "/profiles/kmux/state/remote/target-bindings.json"
    );
    expect(paths.remoteOperationRoot).toBe(
      "/profiles/kmux/state/remote/operations"
    );
    expect(paths.captureRoot).toBe("/profiles/kmux/state/captures");
    expect(paths.rawOutputRoot).toBe("/profiles/kmux/state/pty-raw");
    expect(paths.diagnosticsRoot).toBe("/profiles/kmux/state/diagnostics");
    expect(paths.attachmentRoot).toBe("/profiles/kmux/data/attachments");
    expect(paths.agentHookBinDir).toBe("/profiles/kmux/data/bin");
    expect(paths.agentWrapperBinDir).toBe("/profiles/kmux/data/wrappers");
    expect(paths.nativeCacheRoot).toBe("/profiles/kmux/cache/native");
  });

  it("treats blank Linux path root env values as absent", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        KMUX_CONFIG_DIR: "   ",
        KMUX_RUNTIME_DIR: "   ",
        KMUX_STATE_DIR: "   ",
        KMUX_DATA_DIR: "   ",
        KMUX_CACHE_DIR: "   ",
        XDG_CONFIG_HOME: "   ",
        XDG_RUNTIME_DIR: "   ",
        XDG_STATE_HOME: "   ",
        XDG_DATA_HOME: "   ",
        XDG_CACHE_HOME: "   "
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000,
      statRuntimeDir: () => null
    });

    expect(paths.configDir).toBe("/home/example/.config/kmux");
    expect(paths.runtimeDir).toBe("/tmp/kmux-runtime-1000");
    expect(paths.socketPath).toBe("/tmp/kmux-runtime-1000/control.sock");
    expect(paths.statePath).toBe("/home/example/.local/state/kmux/state.json");
    expect(paths.attachmentRoot).toBe(
      "/home/example/.local/share/kmux/attachments"
    );
    expect(paths.nativeCacheRoot).toBe("/home/example/.cache/kmux/native");
    expect(paths.sources.configDir).toBe("home");
    expect(paths.sources.runtimeDir).toBe("tmp-fallback");
    expect(paths.sources.stateDir).toBe("home");
    expect(paths.sources.dataDir).toBe("home");
    expect(paths.sources.cacheDir).toBe("home");
  });

  it("ignores relative Linux XDG roots before deriving app paths", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        XDG_CONFIG_HOME: "relative-config",
        XDG_RUNTIME_DIR: "relative-runtime",
        XDG_STATE_HOME: "relative-state",
        XDG_DATA_HOME: "relative-data",
        XDG_CACHE_HOME: "relative-cache"
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000,
      statRuntimeDir: () => null
    });

    expect(paths.configDir).toBe("/home/example/.config/kmux");
    expect(paths.runtimeDir).toBe("/tmp/kmux-runtime-1000");
    expect(paths.socketPath).toBe("/tmp/kmux-runtime-1000/control.sock");
    expect(paths.statePath).toBe("/home/example/.local/state/kmux/state.json");
    expect(paths.attachmentRoot).toBe(
      "/home/example/.local/share/kmux/attachments"
    );
    expect(paths.nativeCacheRoot).toBe("/home/example/.cache/kmux/native");
    expect(paths.sources.configDir).toBe("home");
    expect(paths.sources.runtimeDir).toBe("tmp-fallback");
    expect(paths.sources.stateDir).toBe("home");
    expect(paths.sources.dataDir).toBe("home");
    expect(paths.sources.cacheDir).toBe("home");
  });

  it("fails relative explicit Linux app root overrides", () => {
    const cases = [
      ["KMUX_CONFIG_DIR", "relative-config"],
      ["KMUX_RUNTIME_DIR", "relative-runtime"],
      ["KMUX_STATE_DIR", "relative-state"],
      ["KMUX_DATA_DIR", "relative-data"],
      ["KMUX_CACHE_DIR", "relative-cache"]
    ] as const;

    for (const [key, value] of cases) {
      let thrown: unknown;
      try {
        resolveAppPaths({
          homeDir: "/home/example",
          env: {
            XDG_RUNTIME_DIR: "/run/user/1000",
            [key]: value
          },
          platform: "linux",
          tmpDir: "/tmp",
          uid: 1000
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppPathResolutionError);
      expect((thrown as AppPathResolutionError).code).toBe(
        "path-root-not-absolute"
      );
      expect((thrown as Error).message).toContain(
        `${key} must be an absolute path on Linux`
      );
    }
  });

  it("keeps macOS relative explicit app root compatibility", () => {
    const paths = resolveAppPaths({
      homeDir: "/Users/example",
      env: {
        KMUX_CONFIG_DIR: "relative-config",
        KMUX_RUNTIME_DIR: "relative-runtime",
        KMUX_STATE_DIR: "relative-state",
        KMUX_DATA_DIR: "relative-data",
        KMUX_CACHE_DIR: "relative-cache"
      },
      platform: "darwin",
      tmpDir: "/tmp",
      uid: 501
    });

    expect(paths.settingsPath).toBe("relative-config/settings.json");
    expect(paths.socketPath).toBe("relative-runtime/control.sock");
    expect(paths.statePath).toBe("relative-state/state.json");
    expect(paths.attachmentRoot).toBe("relative-runtime/attachments");
    expect(paths.nativeCacheRoot).toBe("relative-cache/native");
  });

  it("trims Linux path root env overrides before deriving app paths", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        KMUX_CONFIG_DIR: " /profiles/kmux/config ",
        KMUX_RUNTIME_DIR: " /profiles/kmux/runtime ",
        KMUX_STATE_DIR: " /profiles/kmux/state ",
        KMUX_DATA_DIR: " /profiles/kmux/data ",
        KMUX_CACHE_DIR: " /profiles/kmux/cache "
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000
    });

    expect(paths.settingsPath).toBe("/profiles/kmux/config/settings.json");
    expect(paths.socketPath).toBe("/profiles/kmux/runtime/control.sock");
    expect(paths.statePath).toBe("/profiles/kmux/state/state.json");
    expect(paths.attachmentRoot).toBe("/profiles/kmux/data/attachments");
    expect(paths.nativeCacheRoot).toBe("/profiles/kmux/cache/native");
  });

  it("keeps Linux non-socket storage out of runtime storage", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        XDG_RUNTIME_DIR: "/run/user/1000"
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000
    });
    const nonSocketPaths = [
      paths.statePath,
      paths.windowStatePath,
      paths.settingsPath,
      paths.usageHistoryPath,
      paths.shellEnvCachePath,
      paths.antigravitySessionsPath,
      paths.desktopInstallationIdentityPath,
      paths.remoteTargetBindingsPath,
      paths.remoteOperationRoot,
      paths.conversionWalRoot,
      paths.retainedSessionInventoryPath,
      paths.captureRoot,
      paths.attachmentRoot,
      paths.rawOutputRoot,
      paths.nativeCacheRoot,
      paths.diagnosticsRoot,
      paths.agentHookBinDir,
      paths.agentWrapperBinDir
    ];

    for (const path of nonSocketPaths) {
      expect(path.startsWith("/run/user/1000/kmux")).toBe(false);
    }
  });

  it("keeps Linux non-socket storage out of explicit runtime overrides", () => {
    const paths = resolveAppPaths({
      homeDir: "/home/example",
      env: {
        KMUX_RUNTIME_DIR: "/profiles/kmux/runtime"
      },
      platform: "linux",
      tmpDir: "/tmp",
      uid: 1000
    });
    const nonSocketPaths = [
      paths.statePath,
      paths.windowStatePath,
      paths.settingsPath,
      paths.usageHistoryPath,
      paths.shellEnvCachePath,
      paths.antigravitySessionsPath,
      paths.desktopInstallationIdentityPath,
      paths.remoteTargetBindingsPath,
      paths.remoteOperationRoot,
      paths.conversionWalRoot,
      paths.retainedSessionInventoryPath,
      paths.captureRoot,
      paths.attachmentRoot,
      paths.rawOutputRoot,
      paths.nativeCacheRoot,
      paths.diagnosticsRoot,
      paths.agentHookBinDir,
      paths.agentWrapperBinDir
    ];

    expect(paths.socketPath).toBe("/profiles/kmux/runtime/control.sock");
    for (const path of nonSocketPaths) {
      expect(path.startsWith("/profiles/kmux/runtime")).toBe(false);
    }
  });

  it("fails an explicit runtime override that produces an overlong socket path", () => {
    expect(() =>
      resolveAppPaths({
        homeDir: "/Users/example",
        env: {
          KMUX_RUNTIME_DIR: join("/", "tmp", "x".repeat(120))
        },
        platform: "darwin",
        tmpDir: "/tmp"
      })
    ).toThrow("KMUX_RUNTIME_DIR produces an overlong Unix socket path");
  });
});
