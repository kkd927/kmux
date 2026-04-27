import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TERMINAL_PANE_CSS = readFileSync(
  path.join(
    process.cwd(),
    "apps/desktop/src/renderer/src/styles/TerminalPane.module.css"
  ),
  "utf8"
);

describe("TerminalPane styles", () => {
  it("does not draw a border or focus ring around the focused pane container", () => {
    const focusedPaneRule = cssRule('.pane[data-focused="true"]');

    expect(focusedPaneRule).not.toContain("border");
    expect(focusedPaneRule).not.toContain("box-shadow");
    expect(focusedPaneRule).not.toContain("--focus-ring");
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = TERMINAL_PANE_CSS.match(
    new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`)
  );
  return match?.[1] ?? "";
}
