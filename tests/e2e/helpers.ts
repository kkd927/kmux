import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from "@playwright/test";

import type {
  JsonRpcEnvelope,
  ShellStoreSnapshot,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload
} from "@kmux/proto";

type TestActiveWorkspace =
  ShellStoreSnapshot["activeWorkspace"] & ShellStoreSnapshot["activeWorkspacePaneTree"];

export type TestShellView = Omit<ShellStoreSnapshot, "activeWorkspace"> & {
  activeWorkspace: TestActiveWorkspace;
};

type KmuxWindow = {
  kmux: {
    getShellState: () => Promise<ShellStoreSnapshot>;
    dispatch: (action: unknown) => Promise<void>;
  };
  kmuxTest?: {
    snapshotSurface: (
      surfaceId: string,
      options?: SurfaceSnapshotOptions
    ) => Promise<SurfaceSnapshotPayload | null>;
  };
};

export interface KmuxSandbox {
  profileRoot: string;
  configDir: string;
  runtimeDir: string;
  socketPath: string;
  shellHomeDir: string;
  shellHistoryPath: string;
  xdgConfigHome: string;
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
  env?: Record<string, string | undefined>;
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
  const shellHomeDir = path.join(profileRoot, "shell-home");
  const xdgConfigHome = path.join(shellHomeDir, ".config");
  const fishConfigDir = path.join(xdgConfigHome, "fish");
  const shellHistoryPath = path.join(shellHomeDir, ".zsh_history");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(shellHomeDir, { recursive: true });
  mkdirSync(fishConfigDir, { recursive: true });
  for (const relativePath of [
    ".zshenv",
    ".zprofile",
    ".zshrc",
    ".zlogin",
    ".bash_profile",
    ".bash_login",
    ".profile",
    path.join(".config", "fish", "config.fish")
  ]) {
    writeFileSync(path.join(shellHomeDir, relativePath), "", "utf8");
  }
  writeFileSync(shellHistoryPath, "", "utf8");
  return {
    profileRoot,
    configDir,
    runtimeDir,
    socketPath,
    shellHomeDir,
    shellHistoryPath,
    xdgConfigHome
  };
}

export function destroySandbox(sandbox: KmuxSandbox): void {
  killSandboxProcesses(sandbox);
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
      KMUX_E2E_DISABLE_QUIT_CONFIRM:
        process.env.KMUX_E2E_DISABLE_QUIT_CONFIRM ?? "1",
      KMUX_CONFIG_DIR: sandbox.configDir,
      KMUX_RUNTIME_DIR: sandbox.runtimeDir,
      KMUX_TEST_FONT_FAMILIES:
        process.env.KMUX_TEST_FONT_FAMILIES ??
        JSON.stringify(["JetBrains Mono", "Fira Code", "Menlo"]),
      HOME: sandbox.shellHomeDir,
      ZDOTDIR: sandbox.shellHomeDir,
      HISTFILE: sandbox.shellHistoryPath,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      ...options.env
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, sandbox, cliPath, workspaceRoot };
}

export async function closeKmuxApp(launched: LaunchedKmux): Promise<void> {
  const appProcess = launched.app.process();
  let closeTimeout: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      launched.app.close(),
      new Promise<never>((_, reject) => {
        closeTimeout = setTimeout(() => {
          reject(new Error("kmux app close timed out"));
        }, 5_000);
      })
    ]);
  } catch {
    if (appProcess?.pid) {
      killProcessTreeByPid(appProcess.pid);
      await waitForProcessExit(appProcess, 5_000).catch(() => undefined);
    }
  } finally {
    if (closeTimeout) {
      clearTimeout(closeTimeout);
    }
  }
}

export async function forceKillKmuxApp(launched: LaunchedKmux): Promise<void> {
  const appProcess = launched.app.process();
  if (!appProcess?.pid || appProcess.exitCode !== null) {
    return;
  }

  killProcessTreeByPid(appProcess.pid);
  await waitForProcessExit(appProcess, 5_000).catch(() => undefined);
}

export async function closeKmux(launched: LaunchedKmux): Promise<void> {
  try {
    await closeKmuxApp(launched);
  } finally {
    destroySandbox(launched.sandbox);
  }
}

async function waitForProcessExit(
  process: ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (process.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeout = null;
      cleanup();
      reject(new Error("kmux process exit timed out"));
    }, timeoutMs);

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      process.off("exit", onExit);
      process.off("error", onError);
    };

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      resolve();
    };

    process.once("exit", onExit);
    process.once("error", onError);
  });
}

function listProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  const output = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], {
    encoding: "utf8"
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return [];
      }

      return [
        {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3]
        }
      ];
    });
}

function descendantProcessIds(rootPid: number): number[] {
  const processes = listProcesses();
  const childrenByParent = new Map<number, number[]>();
  for (const processInfo of processes) {
    const siblings = childrenByParent.get(processInfo.ppid) ?? [];
    siblings.push(processInfo.pid);
    childrenByParent.set(processInfo.ppid, siblings);
  }

  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const nextPid = stack.pop();
    if (!nextPid) {
      continue;
    }
    descendants.push(nextPid);
    stack.push(...(childrenByParent.get(nextPid) ?? []));
  }

  return descendants;
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may already be gone.
  }
}

function killProcessTreeByPid(rootPid: number): void {
  for (const pid of descendantProcessIds(rootPid).reverse()) {
    killPid(pid);
  }
  killPid(rootPid);
}

function killSandboxProcesses(sandbox: KmuxSandbox): void {
  const markers = [
    sandbox.profileRoot,
    sandbox.configDir,
    sandbox.runtimeDir,
    sandbox.shellHomeDir,
    sandbox.xdgConfigHome,
    sandbox.socketPath
  ];

  const matchedPids = listProcesses()
    .filter(
      (processInfo) =>
        processInfo.pid !== process.pid &&
        markers.some((marker) => processInfo.command.includes(marker))
    )
    .map((processInfo) => processInfo.pid);

  const sandboxPids = new Set<number>();
  for (const pid of matchedPids) {
    sandboxPids.add(pid);
    for (const descendantPid of descendantProcessIds(pid)) {
      sandboxPids.add(descendantPid);
    }
  }

  for (const pid of [...sandboxPids].sort((left, right) => right - left)) {
    killPid(pid);
  }
}

function toTestShellView(snapshot: ShellStoreSnapshot): TestShellView {
  return {
    ...snapshot,
    activeWorkspace: {
      ...snapshot.activeWorkspacePaneTree,
      ...snapshot.activeWorkspace
    }
  };
}

export async function getView(page: Page): Promise<TestShellView> {
  return toTestShellView(
    await page.evaluate(
      () => (window as unknown as KmuxWindow).kmux.getShellState()
    )
  );
}

export async function dispatch(
  page: Page,
  action: unknown
): Promise<TestShellView> {
  await page.evaluate(
    (payload) => (window as unknown as KmuxWindow).kmux.dispatch(payload),
    action
  );
  return getView(page);
}

export async function waitForView(
  page: Page,
  predicate: (view: TestShellView) => boolean,
  message: string,
  timeoutMs = 5000
): Promise<TestShellView> {
  const startTime = Date.now();
  let lastState: TestShellView | null = null;

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
    const snapshot = await getSurfaceSnapshot(page, surfaceId);
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

export async function getSurfaceSnapshot(
  page: Page,
  surfaceId: string,
  options?: SurfaceSnapshotOptions
): Promise<SurfaceSnapshotPayload | null> {
  return page.evaluate(({ targetSurfaceId, snapshotOptions }) => {
    const testApi = (window as unknown as KmuxWindow).kmuxTest;
    if (!testApi) {
      throw new Error("kmuxTest bridge unavailable");
    }
    return testApi.snapshotSurface(targetSurfaceId, snapshotOptions);
  }, { targetSurfaceId: surfaceId, snapshotOptions: options });
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
