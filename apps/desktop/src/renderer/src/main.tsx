import React from "react";
import ReactDOM from "react-dom/client";

import { applyThemeVariables } from "@kmux/ui";

import { App } from "./App";
import "./styles/global.css";
import "@vscode/codicons/dist/codicon.css";
import "@xterm/xterm/css/xterm.css";

applyThemeVariables(document.documentElement, "dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
