import * as Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { expect, it } from "vitest";
import { restoreTerminalHistory } from "./restoreTerminalHistory";

it.each(["at-end", "above-output"])(
  "appends the new-session marker without overwriting normal-screen output when cursor is %s",
  async (cursor) => {
    const original = new Headless.Terminal({
      cols: 67,
      rows: 70,
      allowProposedApi: true
    });
    const restored = new Headless.Terminal({
      cols: 67,
      rows: 70,
      allowProposedApi: true
    });
    try {
      const serialize = new SerializeAddon();
      original.loadAddon(serialize);
      const lines = Array.from(
        { length: 50 },
        (_, index) => `STREAM ${String(index).padStart(3, "0")} 한국어 🚀`
      );
      await new Promise<void>((resolve) =>
        original.write(
          lines.join("\r\n") +
            "\r\n" +
            (cursor === "above-output" ? "\u001b[35A" : ""),
          resolve
        )
      );
      await restoreTerminalHistory(restored, serialize.serialize());
      restored.resize(120, 30);
      const content = Array.from(
        { length: restored.buffer.active.length },
        (_, row) => restored.buffer.active.getLine(row)?.translateToString(true)
      ).join("\n");
      for (const line of lines) expect(content).toContain(line);
      expect(content.indexOf("New terminal session")).toBeGreaterThan(
        content.indexOf(lines.at(-1)!)
      );
    } finally {
      original.dispose();
      restored.dispose();
    }
  }
);

it("restores ordinary scrollback and the last alternate screen as history without inheriting TUI input modes", async () => {
  const original = new Headless.Terminal({
    cols: 80,
    rows: 10,
    allowProposedApi: true
  });
  const restored = new Headless.Terminal({
    cols: 80,
    rows: 10,
    allowProposedApi: true
  });
  try {
    const serialize = new SerializeAddon();
    original.loadAddon(serialize);
    await new Promise<void>((resolve) =>
      original.write(
        "Before Agent\r\n\u001b[?1049h\u001b[?2004h\u001b[?1h\u001b[?1003h\u001b[?1004h\u001b[?7l분석 결과 🚀",
        resolve
      )
    );
    await restoreTerminalHistory(restored, serialize.serialize());
    expect(restored.buffer.active.type).toBe("normal");
    expect(restored.modes.bracketedPasteMode).toBe(false);
    expect(restored.modes.applicationCursorKeysMode).toBe(false);
    expect(restored.modes.mouseTrackingMode).toBe("none");
    expect(restored.modes.sendFocusMode).toBe(false);
    expect(restored.modes.wraparoundMode).toBe(true);
    const content = Array.from(
      { length: restored.buffer.active.length },
      (_, row) => restored.buffer.active.getLine(row)?.translateToString(true)
    ).join("\n");
    expect(content).toContain("Before Agent");
    expect(content).toContain("분석 결과 🚀");
    expect(content).toContain("[Restored output. New terminal session.]");
  } finally {
    original.dispose();
    restored.dispose();
  }
});
