import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHORTCUTS,
  LINUX_DEFAULT_SHORTCUTS,
  normalizeShortcutBinding
} from "@kmux/ui";

import {
  buildPlatformKeyboardPolicy,
  isReservedSystemChordBinding
} from "./keyboardPolicy";

describe("platform keyboard policy", () => {
  it("keeps macOS as the compatibility shortcut baseline", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "darwin",
      labelStyle: "mac-symbols"
    });

    expect(policy.platform).toBe("darwin");
    expect(policy.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(policy.labelStyle).toBe("mac-symbols");
    expect(policy.copyModeSelectAllShortcut).toBe("Meta+A");
    expect(policy.workspaceShortcutHintModifier).toBe("Meta");
    expect(policy.numberRowShortcuts).toEqual({
      workspaceModifier: "Meta",
      surfaceModifier: "Ctrl"
    });
  });

  it("uses Linux defaults that avoid common GNOME-reserved chords", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });
    const reservedChords = new Set(
      policy.reservedSystemChords.map(normalizeShortcutBinding)
    );

    expect(policy.platform).toBe("linux");
    expect(policy.shortcuts).toEqual(LINUX_DEFAULT_SHORTCUTS);
    expect(policy.copyModeSelectAllShortcut).toBe("Ctrl+A");
    expect(policy.workspaceShortcutHintModifier).toBeNull();
    expect(policy.numberRowShortcuts).toEqual({
      workspaceModifier: "Alt",
      surfaceModifier: "Ctrl"
    });
    for (const binding of Object.values(policy.shortcuts)) {
      expect(reservedChords.has(normalizeShortcutBinding(binding))).toBe(false);
    }
  });

  it("allows platform policy overrides without mutating defaults", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text",
      shortcuts: {
        "workspace.create": "Ctrl+Alt+N"
      },
      workspaceShortcutHintModifier: null,
      numberRowShortcuts: {
        workspaceModifier: null
      }
    });

    expect(policy.shortcuts["workspace.create"]).toBe("Ctrl+Alt+N");
    expect(LINUX_DEFAULT_SHORTCUTS["workspace.create"]).toBe("Ctrl+Shift+N");
    expect(policy.numberRowShortcuts).toEqual({
      workspaceModifier: null,
      surfaceModifier: "Ctrl"
    });
    expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
  });

  it("detects reserved system chord bindings after shortcut normalization", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });

    expect(
      isReservedSystemChordBinding("Alt+Ctrl+T", policy.reservedSystemChords)
    ).toBe(true);
    expect(
      isReservedSystemChordBinding("Alt+F4", policy.reservedSystemChords)
    ).toBe(true);
    expect(
      isReservedSystemChordBinding(
        LINUX_DEFAULT_SHORTCUTS["workspace.close"],
        policy.reservedSystemChords
      )
    ).toBe(false);
    expect(
      isReservedSystemChordBinding(undefined, policy.reservedSystemChords)
    ).toBe(false);
  });
});
