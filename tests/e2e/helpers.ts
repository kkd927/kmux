import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {createConnection} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {_electron as electron, type ElectronApplication, type Page} from "@playwright/test";

import type {JsonRpcEnvelope, ShellViewModel} from "@kmux/proto";

type KmuxWindow = {
  kmux: {
    getView: () => Promise<ShellViewModel>;
    dispatch: (action: unknown) => Promise<ShellViewModel>;
  };
};

export interface KmuxSandbox {
  profileRoot: string;
  configDir: string;
  runtimeDir: string;
  socketPath: string;
}

export interface LaunchedKmux {
  app: ElectronApplication;
  page: Page;
  sandbox: KmuxSandbox;
  cliPath: string;
  workspaceRoot: string;
}

export interface KmuxLaunchOptions {
  executablePath?: string;
}

export function kmuxPaths(): {
  currentDir: string;
  appRoot: string;
  cliPath: string;
  workspaceRoot: string;
} {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    currentDir,
    appRoot: path.join(currentDir, "..", "..", "apps", "desktop"),
    cliPath: path.join(
      currentDir,
      "..",
      "..",
      "packages",
      "cli",
      "dist",
      "bin.cjs"
    ),
    workspaceRoot: path.join(currentDir, "..", "..")
  };
}

export function createSandbox(prefix: string): KmuxSandbox {
  const profileRoot = mkdtempSync(path.join(tmpdir(), prefix));
  const configDir = path.join(profileRoot, "config");
  const runtimeDir = path.join(profileRoot, "runtime");
  const socketPath = path.join(runtimeDir, "control.sock");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  return { profileRoot, configDir, runtimeDir, socketPath };
}

export function destroySandbox(sandbox: KmuxSandbox): void {
  rmSync(sandbox.profileRoot, { force: true, recursive: true });
}

export async function launchKmux(
  prefix: string,
  options: KmuxLaunchOptions = {}
): Promise<LaunchedKmux> {
  return launchKmuxWithSandbox(createSandbox(prefix), options);
}

export async function launchKmuxWithSandbox(
  sandbox: KmuxSandbox,
  options: KmuxLaunchOptions = {}
): Promise<LaunchedKmux> {
  const { appRoot, cliPath, workspaceRoot } = kmuxPaths();
  const app = await electron.launch({
    args: options.executablePath ? [] : [appRoot],
    ...(options.executablePath
      ? { executablePath: options.executablePath }
      : {}),
    env: {
      ...process.env,
      NODE_ENV: "test",
      KMUX_E2E_WINDOW_MODE: process.env.KMUX_E2E_WINDOW_MODE ?? "background",
      KMUX_CONFIG_DIR: sandbox.configDir,
      KMUX_RUNTIME_DIR: sandbox.runtimeDir
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, sandbox, cliPath, workspaceRoot };
}

export async function closeKmuxApp(launched: LaunchedKmux): Promise<void> {
  await launched.app.close();
}

export async function closeKmux(launched: LaunchedKmux): Promise<void> {
  try {
    await closeKmuxApp(launched);
  } finally {
    destroySandbox(launched.sandbox);
  }
}

export async function getView(page: Page): Promise<ShellViewModel> {
  return page.evaluate(() => (window as unknown as KmuxWindow).kmux.getView());
}

export async function dispatch(
  page: Page,
  action: unknown
): Promise<ShellViewModel> {
  return page.evaluate(
    (payload) => (window as unknown as KmuxWindow).kmux.dispatch(payload),
    action
  );
}

export async function waitForView(
  page: Page,
  predicate: (view: ShellViewModel) => boolean,
  message: string,
  timeoutMs = 5000
): Promise<ShellViewModel> {
  const startTime = Date.now();
  let lastState: ShellViewModel | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const view = await getView(page);
    if (predicate(view)) {
      return view;
    }
    lastState = view;
    await page.waitForTimeout(50);
  }

  throw new Error(
    `${message}; timeout=${timeoutMs}ms; lastState=${JSON.stringify(lastState)}`
  );
}

export async function waitForSurfaceSnapshotContains(
  page: Page,
  surfaceId: string,
  expectedText: string,
  timeoutMs = 5000
): Promise<string> {
  const startTime = Date.now();
  let lastSnapshot = "";

  while (Date.now() - startTime < timeoutMs) {
    const snapshot = await page.evaluate(
      (targetSurfaceId) => window.kmux.attachSurface(targetSurfaceId),
      surfaceId
    );
    lastSnapshot = snapshot?.vt ?? "";
    if (lastSnapshot.includes(expectedText)) {
      return lastSnapshot;
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `surface ${surfaceId} did not contain expected text "${expectedText}" within ${timeoutMs}ms; lastSnapshot=${JSON.stringify(lastSnapshot)}`
  );
}

export function runCliJson<T>(
  cliPath: string,
  workspaceRoot: string,
  socketPath: string,
  args: string[]
): T {
  return JSON.parse(
    execFileSync("node", [cliPath, ...args], {
      cwd: workspaceRoot,
      env: { ...process.env, KMUX_SOCKET_PATH: socketPath },
      encoding: "utf8"
    })
  ) as T;
}

export async function sendRpc<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => {
      const envelope: JsonRpcEnvelope<Record<string, unknown>> = {
        jsonrpc: "2.0",
        id: "test",
        method,
        params
      };
      socket.write(`${JSON.stringify(envelope)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) {
        return;
      }
      const line = buffer.split("\n")[0];
      const response = JSON.parse(line) as JsonRpcEnvelope<T>;
      socket.end();
      if (response.error) {
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.result as T);
    });
    socket.on("error", reject);
  });
}
