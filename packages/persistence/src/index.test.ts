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
});
