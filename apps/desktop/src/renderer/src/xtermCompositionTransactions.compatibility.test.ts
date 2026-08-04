// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  SUPPORTED_XTERM_COMPOSITION_VERSION,
  getXtermCompositionSettlement,
  installXtermCompositionTransactions
} from "./xtermCompositionTransactions";

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

describe("xterm composition private API compatibility", () => {
  it("opens the installed xterm 6.0.0 and installs the reconciler", async () => {
    const require = createRequire(import.meta.url);
    const packageJson = JSON.parse(
      readFileSync(require.resolve("@xterm/xterm/package.json"), "utf8")
    ) as { version?: string };
    expect(packageJson.version).toBe(SUPPORTED_XTERM_COMPOSITION_VERSION);

    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "matchMedia"
    );
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver"
    );
    const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "requestAnimationFrame"
    );
    const cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "cancelAnimationFrame"
    );
    const canvasContextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext"
    );

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false
      })
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0)
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (handle: number) => window.clearTimeout(handle)
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () =>
        ({
          canvas: document.createElement("canvas"),
          createLinearGradient: () => ({ addColorStop() {} }),
          measureText: () => ({ width: 8 }),
          fillRect() {},
          clearRect() {},
          getImageData: () => ({
            data: new Uint8ClampedArray([0, 0, 0, 255])
          }),
          setTransform() {},
          save() {},
          restore() {},
          beginPath() {},
          closePath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fillText() {},
          scale() {},
          translate() {},
          rect() {},
          clip() {}
        }) as unknown as CanvasRenderingContext2D
    });

    let terminal:
      | (XtermTerminal & {
          _core?: {
            _compositionHelper?: {
              compositionstart(): void;
              compositionend(): void;
            };
          };
        })
      | undefined;
    let host: HTMLDivElement | undefined;
    try {
      const { Terminal } = await import("@xterm/xterm");
      terminal = new Terminal({ allowProposedApi: true });
      host = document.createElement("div");
      document.body.appendChild(host);
      terminal.open(host);

      const installation = installXtermCompositionTransactions(terminal);
      expect(installation.installed).toBe(true);
      terminal._core?._compositionHelper?.compositionstart();
      terminal._core?._compositionHelper?.compositionend();
      const settlement = getXtermCompositionSettlement(terminal);
      expect(settlement).not.toBeNull();

      terminal.textarea?.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true
        })
      );
      await settlement?.promise;
    } finally {
      terminal?.dispose();
      host?.remove();
      restoreProperty(window, "matchMedia", matchMediaDescriptor);
      restoreProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
      restoreProperty(
        window,
        "requestAnimationFrame",
        requestAnimationFrameDescriptor
      );
      restoreProperty(
        window,
        "cancelAnimationFrame",
        cancelAnimationFrameDescriptor
      );
      restoreProperty(
        HTMLCanvasElement.prototype,
        "getContext",
        canvasContextDescriptor
      );
    }
  });
});
