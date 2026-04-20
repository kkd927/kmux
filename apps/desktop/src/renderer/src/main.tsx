import React from "react";
import ReactDOM from "react-dom/client";

import { applyThemeVariables } from "@kmux/ui";

import { App } from "./App";
import "./styles/global.css";
import "@vscode/codicons/dist/codicon.css";
import "@xterm/xterm/css/xterm.css";

applyThemeVariables(document.documentElement, "dark");

// Preload the built-in Nerd Font so xterm.js can render Nerd Font glyphs on
// its first paint without waiting for lazy font resolution. Without this,
// document.fonts.ready can resolve before the font is queued for download,
// leaving cold-start canvas renders with tofu until the next paint.
void document.fonts?.load?.("13px \"kmux Symbols Nerd Font Mono\"");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
