import type {
  TerminalInputDiagnosticKind,
  TerminalOutputDiagnosticKind
} from "@kmux/proto";

export type {
  TerminalInputDiagnosticKind,
  TerminalOutputDiagnosticKind
} from "@kmux/proto";

const FOCUS_IN = "\u001b[I";
const FOCUS_OUT = "\u001b[O";
const ESCAPE = String.fromCharCode(27);
const SGR_MOUSE_INPUT = new RegExp(`^(?:${ESCAPE}\\[<\\d+;\\d+;\\d+[Mm])+$`);
const X10_MOUSE_INPUT = new RegExp(`^(?:${ESCAPE}\\[M[\\s\\S]{3})+$`);

export function classifyTerminalTextInput(
  text: string
): TerminalInputDiagnosticKind {
  if (text === FOCUS_IN) {
    return "focus-in";
  }
  if (text === FOCUS_OUT) {
    return "focus-out";
  }
  if (SGR_MOUSE_INPUT.test(text) || X10_MOUSE_INPUT.test(text)) {
    return "mouse";
  }
  return "keyboard-or-paste";
}

export function classifyTerminalBinaryInput(
  data: string
): TerminalInputDiagnosticKind {
  return SGR_MOUSE_INPUT.test(data) || X10_MOUSE_INPUT.test(data)
    ? "mouse"
    : "binary";
}

type ParserMode =
  | "unknown"
  | "unknown-escape"
  | "ground"
  | "escape"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

type OscKind = "unknown" | "title" | "other";

/**
 * Classifies PTY reads without retaining terminal content. The parser carries
 * string-control state across reads so a split OSC title still cannot be
 * mistaken for a body repaint.
 */
export interface TerminalOutputDiagnosticClassifier {
  classify(chunk: string): TerminalOutputDiagnosticKind;
  /** Marks reads unknown after diagnostics skipped part of the byte stream. */
  invalidate(): void;
  reset(): void;
}

export function createTerminalOutputDiagnosticClassifier(): TerminalOutputDiagnosticClassifier {
  let mode: ParserMode = "ground";
  let oscKind: OscKind = "unknown";
  let oscCommand = "";

  const reset = (): void => {
    mode = "ground";
    oscKind = "unknown";
    oscCommand = "";
  };
  const invalidate = (): void => {
    mode = "unknown";
    oscKind = "unknown";
    oscCommand = "";
  };

  return {
    classify(chunk) {
      const startedIndeterminate =
        mode === "unknown" || mode === "unknown-escape";
      let sawScreen = false;
      let sawTitleOsc = false;
      let sawOtherOsc = false;
      let sawOtherControl = false;

      const markOsc = (): void => {
        if (oscKind === "title") {
          sawTitleOsc = true;
        } else if (oscKind === "other") {
          sawOtherOsc = true;
        }
      };

      const enterOsc = (): void => {
        mode = "osc";
        oscKind = "unknown";
        oscCommand = "";
      };

      for (let index = 0; index < chunk.length; index += 1) {
        const character = chunk[index]!;
        const code = character.charCodeAt(0);

        switch (mode) {
          case "unknown":
            if (character === "\u001b") {
              mode = "unknown-escape";
            } else if (character === "\u0007" || character === "\u009c") {
              mode = "ground";
            }
            break;

          case "unknown-escape":
            if (character === "\\") {
              mode = "ground";
            } else if (character === "]") {
              enterOsc();
            } else if (character === "[") {
              sawScreen = true;
              mode = "csi";
            } else if (
              character === "P" ||
              character === "X" ||
              character === "^" ||
              character === "_"
            ) {
              sawScreen = true;
              mode = "string";
            } else {
              sawScreen = true;
              mode = "ground";
            }
            break;

          case "ground":
            if (character === "\u001b") {
              mode = "escape";
            } else if (character === "\u009d") {
              enterOsc();
            } else if (character === "\u009b") {
              sawScreen = true;
              mode = "csi";
            } else if (
              character === "\u0090" ||
              character === "\u0098" ||
              character === "\u009e" ||
              character === "\u009f"
            ) {
              sawScreen = true;
              mode = "string";
            } else if (
              code >= 0x20 ||
              character === "\r" ||
              character === "\n" ||
              character === "\t" ||
              character === "\b"
            ) {
              sawScreen = true;
            } else {
              sawOtherControl = true;
            }
            break;

          case "escape":
            if (character === "]") {
              enterOsc();
            } else if (character === "[") {
              sawScreen = true;
              mode = "csi";
            } else if (
              character === "P" ||
              character === "X" ||
              character === "^" ||
              character === "_"
            ) {
              sawScreen = true;
              mode = "string";
            } else {
              // RIS, IND, NEL, RI, and other ESC dispatches may mutate the
              // presentation even though they are not CSI sequences.
              sawScreen = true;
              mode = "ground";
            }
            break;

          case "csi":
            sawScreen = true;
            if (code >= 0x40 && code <= 0x7e) {
              mode = "ground";
            }
            break;

          case "osc":
            if (character === "\u0007") {
              markOsc();
              mode = "ground";
              oscKind = "unknown";
              oscCommand = "";
              break;
            }
            if (character === "\u001b") {
              markOsc();
              mode = "osc-escape";
              break;
            }
            if (oscKind === "unknown") {
              if (character === ";") {
                oscKind =
                  oscCommand === "0" || oscCommand === "1" || oscCommand === "2"
                    ? "title"
                    : "other";
              } else if (/\d/.test(character) && oscCommand.length < 8) {
                oscCommand += character;
              } else {
                oscKind = "other";
              }
            }
            markOsc();
            break;

          case "osc-escape":
            markOsc();
            if (character === "\\") {
              mode = "ground";
              oscKind = "unknown";
              oscCommand = "";
            } else {
              mode = "osc";
            }
            break;

          case "string":
            // DCS/APC and related control strings may carry graphics or other
            // presentation updates, so treating them as screen is safer than
            // claiming that only non-screen metadata was emitted.
            sawScreen = true;
            if (character === "\u001b") {
              mode = "string-escape";
            }
            break;

          case "string-escape":
            sawScreen = true;
            mode = character === "\\" ? "ground" : "string";
            break;
        }
      }

      if (mode === "osc" || mode === "osc-escape") {
        markOsc();
      }

      if (startedIndeterminate) {
        return "indeterminate";
      }

      const sawNonScreen = sawTitleOsc || sawOtherOsc || sawOtherControl;
      if (sawScreen && sawNonScreen) {
        return "mixed";
      }
      if (sawScreen) {
        return "screen";
      }
      if (sawTitleOsc && (sawOtherOsc || sawOtherControl)) {
        return "mixed";
      }
      if (sawTitleOsc) {
        return "osc-title-only";
      }
      if (sawOtherOsc) {
        return "osc-only";
      }
      return "control-only";
    },
    invalidate,
    reset
  };
}
