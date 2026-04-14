import { describe, expect, it, vi } from "vitest";

import { applyTerminalWebglPreference } from "./terminalRenderer";

describe("terminal renderer helpers", () => {
  it("loads the WebGL addon once when enabled", () => {
    const addon = {
      dispose: vi.fn()
    };
    const terminal = {
      loadAddon: vi.fn()
    };

    const loadedAddon = applyTerminalWebglPreference({
      terminal,
      currentAddon: null,
      useWebgl: true,
      createAddon: () => addon
    });
    const reusedAddon = applyTerminalWebglPreference({
      terminal,
      currentAddon: loadedAddon,
      useWebgl: true,
      createAddon: () => {
        throw new Error("should not create another addon");
      }
    });

    expect(loadedAddon).toBe(addon);
    expect(reusedAddon).toBe(addon);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);
  });

  it("disposes the WebGL addon when disabled", () => {
    const addon = {
      dispose: vi.fn()
    };

    const nextAddon = applyTerminalWebglPreference({
      terminal: {
        loadAddon: vi.fn()
      },
      currentAddon: addon,
      useWebgl: false,
      createAddon: () => addon
    });

    expect(nextAddon).toBeNull();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back cleanly when the WebGL addon fails to load", () => {
    const loadError = new Error("webgl unavailable");
    const onLoadError = vi.fn();

    const nextAddon = applyTerminalWebglPreference({
      terminal: {
        loadAddon: vi.fn(() => {
          throw loadError;
        })
      },
      currentAddon: null,
      useWebgl: true,
      createAddon: () => ({
        dispose: vi.fn()
      }),
      onLoadError
    });

    expect(nextAddon).toBeNull();
    expect(onLoadError).toHaveBeenCalledWith(loadError);
  });
});
