import { describe, expect, it } from "vitest";

import { buildPlatformKeyboardPolicy } from "../../../shared/platform/keyboardPolicy";
import { formatRecordedShortcut } from "./AppOverlays";

describe("settings shortcut recorder", () => {
  it("does not record Linux reserved system chords", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });

    expect(
      formatRecordedShortcut(
        {
          key: "t",
          code: "KeyT",
          ctrlKey: true,
          altKey: true,
          metaKey: false,
          shiftKey: false
        },
        policy.reservedSystemChords
      )
    ).toBeNull();
    expect(
      formatRecordedShortcut(
        {
          key: "F4",
          code: "F4",
          ctrlKey: false,
          altKey: true,
          metaKey: false,
          shiftKey: false
        },
        policy.reservedSystemChords
      )
    ).toBeNull();
  });

  it("keeps non-reserved shortcut recording behavior intact", () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });

    expect(
      formatRecordedShortcut(
        {
          key: "w",
          code: "KeyW",
          ctrlKey: true,
          altKey: true,
          metaKey: false,
          shiftKey: false
        },
        policy.reservedSystemChords
      )
    ).toBe("Ctrl+Alt+W");
    expect(
      formatRecordedShortcut(
        {
          key: "Alt",
          code: "AltLeft",
          ctrlKey: false,
          altKey: true,
          metaKey: false,
          shiftKey: false
        },
        policy.reservedSystemChords
      )
    ).toBeNull();
  });
});
