import { describe, expect, it } from "vitest";

import {
  classifyTerminalBinaryInput,
  classifyTerminalTextInput,
  createTerminalOutputDiagnosticClassifier
} from "./terminalInteractionDiagnostics";

describe("terminal interaction diagnostics", () => {
  it("classifies focus and mouse input without recording its contents", () => {
    expect(classifyTerminalTextInput("\u001b[I")).toBe("focus-in");
    expect(classifyTerminalTextInput("\u001b[O")).toBe("focus-out");
    expect(classifyTerminalTextInput("\u001b[<64;40;12M")).toBe("mouse");
    expect(classifyTerminalBinaryInput("\u001b[M !!")).toBe("mouse");
    expect(classifyTerminalTextInput("hello")).toBe("keyboard-or-paste");
    expect(classifyTerminalBinaryInput("raw")).toBe("binary");
  });

  it("distinguishes title-only output from terminal body repaints", () => {
    const classifier = createTerminalOutputDiagnosticClassifier();

    expect(classifier.classify("\u001b]0;thinking\u0007")).toBe(
      "osc-title-only"
    );
    expect(classifier.classify("\u001b[?25l\u001b[HReticulating")).toBe(
      "screen"
    );
    expect(classifier.classify("\u001b]0;thinking\u0007\u001b[Hbody")).toBe(
      "mixed"
    );
    expect(classifier.classify("\u001b]7;file://host/repo\u0007")).toBe(
      "osc-only"
    );
    expect(classifier.classify("\u001bc")).toBe("screen");
    expect(classifier.classify("\u001bPgraphics\u001b\\")).toBe("screen");
  });

  it("carries a split OSC title across PTY reads", () => {
    const classifier = createTerminalOutputDiagnosticClassifier();

    expect(classifier.classify("\u001b]0;think")).toBe("osc-title-only");
    expect(classifier.classify("ing\u0007")).toBe("osc-title-only");
    expect(classifier.classify("next body")).toBe("screen");
  });

  it("keeps split CSI output classified as screen-affecting", () => {
    const classifier = createTerminalOutputDiagnosticClassifier();

    expect(classifier.classify("\u001b[")).toBe("screen");
    expect(classifier.classify("?25l")).toBe("screen");
  });

  it("does not guess the first output kind after diagnostics skipped bytes", () => {
    const classifier = createTerminalOutputDiagnosticClassifier();

    classifier.invalidate();
    expect(classifier.classify("unknown prior state")).toBe("indeterminate");
    expect(classifier.classify("\u001b]0;thinking\u0007")).toBe(
      "indeterminate"
    );
    expect(classifier.classify("next body")).toBe("screen");
  });
});
