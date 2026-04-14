import { createInitialState } from "@kmux/core";
import { vi } from "vitest";

const { beep, showNotification } = vi.hoisted(() => ({
  beep: vi.fn(),
  showNotification: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  },
  Notification: class {
    constructor(private readonly options: { title: string; body: string }) {}

    show(): void {
      showNotification(this.options);
    }
  },
  shell: {
    beep
  }
}));

import { AppStore } from "./store";
import { createAppRuntime } from "./appRuntime";

function createRuntime(notificationSound: boolean) {
  const initialState = createInitialState("/bin/zsh");
  initialState.settings.notificationSound = notificationSound;
  const runtime = createAppRuntime({
    paths: {
      socketPath: "/tmp/kmux.sock"
    },
    snapshotStore: {
      path: "/tmp/kmux-snapshot.json",
      load: () => null,
      save: vi.fn()
    },
    windowStateStore: {
      path: "/tmp/kmux-window.json",
      load: () => null,
      save: vi.fn()
    },
    settingsStore: {
      path: "/tmp/kmux-settings.json",
      load: () => null,
      save: vi.fn()
    },
    defaultShellPath: "/bin/zsh",
    refreshMetadata: vi.fn(),
    persistWindowState: vi.fn()
  });

  runtime.setStore(new AppStore(initialState));

  return runtime;
}

describe("app runtime bell sound effects", () => {
  it("plays a bell sound when enabled", () => {
    beep.mockClear();
    showNotification.mockClear();

    createRuntime(true).runEffects([{ type: "bell.sound" }]);

    expect(beep).toHaveBeenCalledTimes(1);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("skips bell sounds when disabled", () => {
    beep.mockClear();

    createRuntime(false).runEffects([{ type: "bell.sound" }]);

    expect(beep).not.toHaveBeenCalled();
  });
});
