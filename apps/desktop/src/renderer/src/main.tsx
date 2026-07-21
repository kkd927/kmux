import React from "react";
import ReactDOM from "react-dom/client";

import {
  DEFAULT_TERMINAL_TEXT_FONT_FAMILY,
  KMUX_BUILTIN_SYMBOL_FONT_FAMILY
} from "@kmux/core";
import { applyThemeVariables } from "@kmux/ui";

import { App } from "./App";
import { installRendererDiagnostics } from "./rendererDiagnostics";
import "./styles/global.css";
import "@vscode/codicons/dist/codicon.css";
import "@xterm/xterm/css/xterm.css";

applyThemeVariables(document.documentElement, "dark");
installRendererDiagnostics();

// Preload bundled terminal fonts so xterm.js measures and paints cells against
// the final monospace metrics from its first render.
void Promise.all([
  document.fonts?.load?.(`13px ${DEFAULT_TERMINAL_TEXT_FONT_FAMILY}`),
  document.fonts?.load?.(`bold 13px ${DEFAULT_TERMINAL_TEXT_FONT_FAMILY}`),
  document.fonts?.load?.(`italic 13px ${DEFAULT_TERMINAL_TEXT_FONT_FAMILY}`),
  document.fonts?.load?.(
    `bold italic 13px ${DEFAULT_TERMINAL_TEXT_FONT_FAMILY}`
  ),
  document.fonts?.load?.(`13px ${KMUX_BUILTIN_SYMBOL_FONT_FAMILY}`)
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
