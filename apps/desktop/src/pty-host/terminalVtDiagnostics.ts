import type { Terminal } from "@xterm/headless";

export interface TerminalVtDiagnosticsRegistration {
  dispose(): void;
}

export type TerminalVtDestructiveEvent =
  | {
      kind: "erase-display";
      mode: 2 | 3;
    }
  | {
      kind: "terminal-reset";
    }
  | {
      kind: "alternate-screen";
      action: "enter" | "exit";
      modes: number[];
    };

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

/**
 * Observes destructive VT operations without consuming them. Returning false
 * from every parser hook lets xterm's built-in handler apply the sequence.
 */
export function registerTerminalVtDiagnostics(
  terminal: Pick<Terminal, "parser">,
  onEvent: (event: TerminalVtDestructiveEvent) => void
): TerminalVtDiagnosticsRegistration {
  const emit = (event: TerminalVtDestructiveEvent): void => {
    try {
      onEvent(event);
    } catch {
      // Diagnostics must never alter terminal parsing.
    }
  };
  const registrations = [
    terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
      const mode = params[0] ?? 0;
      if (mode === 2 || mode === 3) {
        emit({ kind: "erase-display", mode });
      }
      return false;
    }),
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      emit({ kind: "terminal-reset" });
      return false;
    }),
    terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        const modes = Array.from(params).filter(
          (mode): mode is number =>
            typeof mode === "number" && ALTERNATE_SCREEN_MODES.has(mode)
        );
        if (modes.length > 0) {
          emit({ kind: "alternate-screen", action: "enter", modes });
        }
        return false;
      }
    ),
    terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        const modes = Array.from(params).filter(
          (mode): mode is number =>
            typeof mode === "number" && ALTERNATE_SCREEN_MODES.has(mode)
        );
        if (modes.length > 0) {
          emit({ kind: "alternate-screen", action: "exit", modes });
        }
        return false;
      }
    )
  ];

  return {
    dispose(): void {
      for (const registration of registrations.reverse()) {
        registration.dispose();
      }
    }
  };
}

export function syncTerminalVtDiagnosticsRegistration(
  options:
    | {
        enabled: false;
        current?: TerminalVtDiagnosticsRegistration;
      }
    | {
        enabled: true;
        current?: TerminalVtDiagnosticsRegistration;
        register: () => TerminalVtDiagnosticsRegistration;
      }
): TerminalVtDiagnosticsRegistration | undefined {
  if (!options.enabled) {
    options.current?.dispose();
    return undefined;
  }
  return options.current ?? options.register();
}
