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

  it("matches the terminal input background to the right sidebar background token", () => {
    expect(cssRule(".pane")).toContain(
      "--terminal-input-bg: var(--window-bg)"
    );
    expect(cssRule(".meta")).toContain("background: var(--terminal-input-bg)");
    expect(cssRule(".terminal")).toContain(
      "background: var(--terminal-input-bg)"
    );
    expect(
      cssRule(".terminalViewport :global(.xterm .xterm-helper-textarea)")
    ).toContain("background-color: var(--terminal-input-bg)");
    expect(
      cssRule(".terminalViewport :global(.xterm .xterm-viewport)")
    ).toContain("background-color: var(--terminal-input-bg) !important");
  });

  it("lets the active tab indicator replace the pane top border segment", () => {
    expect(cssRule(".pane")).toContain("border-top: 0");
    expect(cssRule(".header")).toContain("position: relative");
    expect(cssRule(".header::before")).toContain(
      "background: var(--border-strong)"
    );

    expect(cssRule('.tabItem[data-active="true"]')).toContain(
      "box-shadow: inset 0 1px 0 var(--tab-indicator)"
    );
    expect(cssRule('.tabItem[data-active="true"]')).toContain("z-index: 2");
    expect(cssRule('.tabItem[data-active="true"]::before')).toBe("");
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = TERMINAL_PANE_CSS.match(
    new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`)
  );
  return match?.[1] ?? "";
}
