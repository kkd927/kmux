import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState } from "@kmux/core";

import {
  createSettingsStore,
  createSnapshotStore,
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
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 1,
      snapshot: state
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
        version: 2,
        snapshot: createInitialState("/bin/zsh")
      })
    );

    expect(createSnapshotStore(statePath).load()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported version 2")
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
      version: 1,
      snapshot: secondState
    });
  });

  it("roundtrips usage history with a versioned envelope", async () => {
    const usageHistoryPath = join(sandboxDir, "usage-history.json");
    const persistenceModule = (await import("./index")) as {
      createUsageHistoryStore?: (path: string, pricingRevision?: string) => {
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
        activeSessionCount: 3,
        vendors: [
          {
            vendor: "claude",
            totalCostUsd: 1.9,
            totalTokens: 1880,
            activeSessionCount: 2
          },
          {
            vendor: "codex",
            totalCostUsd: 0.5,
            totalTokens: 600,
            activeSessionCount: 1
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
    const usageHistoryPath = join(sandboxDir, "usage-history-pricing-revision.json");
    const persistenceModule = (await import("./index")) as {
      createUsageHistoryStore?: (path: string, pricingRevision?: string) => {
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
        activeSessionCount: 2,
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

  it("returns the dedicated usage history path in the default app paths", async () => {
    const configDir = join(sandboxDir, "config");
    const runtimeDir = join(sandboxDir, "runtime");
    const { defaultAppPaths } = await import("./index");

    expect(
      defaultAppPaths("/Users/example", {
        KMUX_CONFIG_DIR: configDir,
        KMUX_RUNTIME_DIR: runtimeDir
      }).usageHistoryPath
    ).toBe(join(configDir, "usage-history.json"));
  });
});
