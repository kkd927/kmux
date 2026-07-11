import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

/**
 * Keeps model-state terminal query replies authoritative in the PTY
 * supervisor. Browser-only queries (colors, pixels, focus, mouse) continue to
 * bubble to the renderer because the headless terminal cannot answer them
 * from view state.
 */
export class SupervisorTerminalQueryAuthorityAddon implements ITerminalAddon {
  private registrations: IDisposable[] = [];

  activate(terminal: Terminal): void {
    this.disposeRegistrations();
    const parser = terminal.parser;
    this.registrations = [
      parser.registerCsiHandler({ final: "c" }, consume),
      parser.registerCsiHandler({ prefix: ">", final: "c" }, consume),
      parser.registerCsiHandler({ final: "n" }, consume),
      parser.registerCsiHandler({ prefix: "?", final: "n" }, consume),
      parser.registerCsiHandler({ intermediates: "$", final: "p" }, consume),
      parser.registerCsiHandler(
        { prefix: "?", intermediates: "$", final: "p" },
        consume
      ),
      parser.registerCsiHandler({ final: "t" }, (params) => params[0] === 18),
      parser.registerDcsHandler({ intermediates: "$", final: "q" }, consumeDcs)
    ];
  }

  dispose(): void {
    this.disposeRegistrations();
  }

  private disposeRegistrations(): void {
    for (const registration of this.registrations.splice(0).reverse()) {
      registration.dispose();
    }
  }
}

function consume(): true {
  return true;
}

function consumeDcs(): true {
  return true;
}
