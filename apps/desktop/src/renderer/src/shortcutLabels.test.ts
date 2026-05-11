import { describe, expect, it } from "vitest";

import { formatShortcutLabel, formatShortcutParts } from "./shortcutLabels";

describe("formatShortcutLabel", () => {
  it("formats macOS shortcuts with symbolic keys and an optional separator", () => {
    expect(
      formatShortcutLabel("Meta+Shift+P", true, { separator: " " })
    ).toBe("⌘ ⇧ P");
    expect(
      formatShortcutLabel("Alt+Meta+ArrowLeft", true, { separator: " " })
    ).toBe("⌥ ⌘ ←");
    expect(
      formatShortcutLabel("Meta+Alt+ArrowLeft", true, { separator: " " })
    ).toBe("⌥ ⌘ ←");
    expect(formatShortcutParts("Meta+Shift+P", true)).toEqual(["⌘", "⇧", "P"]);
  });

  it("keeps non-macOS shortcuts readable with textual modifier names", () => {
    expect(formatShortcutLabel("Meta+Shift+P", false)).toBe("Meta + Shift + P");
  });
});
