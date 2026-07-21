import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startSshTarget } from "../ssh/harness/sshTarget";
import {
  closeKmuxApp,
  createSandbox,
  destroySandbox,
  forceKillKmuxApp,
  getView,
  launchKmuxWithSandbox,
  waitForView,
  type KmuxSandbox,
  type LaunchedKmux
} from "./helpers";

interface SshWorkspaceTestApi {
  getShellState(): Promise<{
    activeWorkspace: { id: string };
  }>;
  getSshConnections(): Promise<{
    profiles: Array<{
      name: string;
      lastError?: { at: string; message: string };
    }>;
  }>;
  saveSshProfile(request: {
    profile: {
      name: string;
      sshConfigHost: string;
      defaultRemoteCwd: string;
      forwardAgent: boolean;
    };
  }): Promise<{ id: string }>;
  prepareSshWorkspace(request: {
    requestId: string;
    sourceWorkspaceId: string;
    profileId: string;
    continuation: "convert";
  }): Promise<{ preparationId: string }>;
  commitSshWorkspace(request: { preparationId: string }): Promise<{
    workspaceId: string;
    targetId: string;
  }>;
}

test("real SSH workspace survives desktop loss and restores the same keeper", async () => {
  test.setTimeout(300_000);
  const target = await startSshTarget();
  const sandbox = createSandbox("kmux-ssh-e2e-");
  let first: LaunchedKmux | undefined;
  let relaunched: LaunchedKmux | undefined;
  const consoleMessages: string[] = [];
  try {
    enableSandboxDiagnostics(sandbox);
    installSshFixtureConfig(sandbox, target.sshConfigPath);
    first = await launchKmuxWithSandbox(sandbox);
    recordPageConsole(first.page, consoleMessages);
    const opened = await createRemoteWorkspace(first.page, target.hostAlias);
    const firstView = await waitForView(
      first.page,
      (view) =>
        view.activeWorkspace.id === opened.workspaceId &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) =>
            surface.content.runtimeStatus === "running" &&
            surface.content.shellInputReady === true
        ),
      "real SSH workspace should become ready",
      90_000
    );
    const surfaceId = Object.keys(firstView.activeWorkspace.surfaces)[0]!;
    await expect(
      first.page.getByTestId(`terminal-${surfaceId}`)
    ).toHaveAttribute("data-terminal-stream-ready", /^attach_/, {
      timeout: 30_000
    });
    await sendMarker(first.page, surfaceId, "kmux_ssh_before_restore");
    const keeperPids = await readKeeperPids(target.target);
    expect(keeperPids.length).toBeGreaterThan(0);

    await forceKillKmuxApp(first);
    await expect
      .poll(() => readKeeperPids(target.target), { timeout: 15_000 })
      .toEqual(keeperPids);

    relaunched = await launchKmuxWithSandbox(sandbox);
    recordPageConsole(relaunched.page, consoleMessages);
    const restored = await waitForSshRestore(
      relaunched.page,
      (view) =>
        view.activeWorkspace.id === opened.workspaceId &&
        Object.values(view.activeWorkspace.surfaces).some(
          (surface) =>
            surface.id === surfaceId &&
            surface.content.runtimeStatus === "running" &&
            surface.content.shellInputReady === true
        ),
      "desktop relaunch should restore the existing remote keeper",
      90_000
    );
    expect(restored.activeWorkspace.id).toBe(opened.workspaceId);
    await expect(
      relaunched.page.getByTestId(`terminal-${surfaceId}`)
    ).toHaveAttribute("data-terminal-stream-ready", /^attach_/, {
      timeout: 30_000
    });
    const restoredRows = committedTerminalRows(relaunched.page, surfaceId);
    // Restore hydrates a replacement xterm offscreen before atomically
    // committing it. Ignore that explicitly marked transaction host so a
    // back-to-back checkpoint cannot make this locator ambiguous.
    await expect(restoredRows).toHaveCount(1, { timeout: 30_000 });
    await expect(restoredRows).toContainText("kmux_ssh_before_restore", {
      timeout: 30_000
    });
    await sendMarker(relaunched.page, surfaceId, "kmux_ssh_after_restore");
    expect(await readKeeperPids(target.target)).toEqual(keeperPids);
  } catch (error) {
    await attachFailureDiagnostics({
      sandbox,
      target: target.target,
      page: relaunched?.page ?? first?.page,
      consoleMessages
    });
    throw error;
  } finally {
    if (relaunched) {
      await closeKmuxApp(relaunched).catch(() => undefined);
    } else if (first) {
      await closeKmuxApp(first).catch(() => undefined);
    }
    destroySandbox(sandbox);
    await target.stop();
  }
});

function enableSandboxDiagnostics(sandbox: KmuxSandbox): void {
  writeFileSync(
    join(sandbox.configDir, "settings.json"),
    `${JSON.stringify({ diagnosticLoggingEnabled: true }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function recordPageConsole(page: Page, messages: string[]): void {
  page.on("console", (message) => {
    if (messages.length < 512) {
      messages.push(`${message.type()}: ${message.text()}`);
    }
  });
}

async function attachFailureDiagnostics(options: {
  sandbox: KmuxSandbox;
  target: {
    exec(command: string[]): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  page: Page | undefined;
  consoleMessages: string[];
}): Promise<void> {
  const diagnosticsLog = join(
    options.sandbox.stateDir,
    "diagnostics",
    "kmux-debug.log"
  );
  const [view, connections, terminalDom, remote] = await Promise.all([
    options.page
      ? getView(options.page).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
      : Promise.resolve({ error: "page unavailable" }),
    options.page
      ? options.page
          .evaluate(async () => {
            const api = (window as unknown as { kmux: SshWorkspaceTestApi })
              .kmux;
            return await api.getSshConnections();
          })
          .catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error)
          }))
      : Promise.resolve({ error: "page unavailable" }),
    options.page
      ? options.page
          .locator('[data-testid^="terminal-"]')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              testId: element.getAttribute("data-testid"),
              attributes: Object.fromEntries(
                [...element.attributes].map((attribute) => [
                  attribute.name,
                  attribute.value
                ])
              ),
              hosts: [...element.children].map((child) => ({
                attributes: Object.fromEntries(
                  [...child.attributes].map((attribute) => [
                    attribute.name,
                    attribute.value
                  ])
                ),
                text: child.textContent?.slice(0, 16 * 1024) ?? ""
              }))
            }))
          )
          .catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error)
          }))
      : Promise.resolve({ error: "page unavailable" }),
    options.target
      .exec([
        "sh",
        "-lc",
        [
          "printf '%s\\n' '## processes'",
          "ps -ef | grep '[k]muxd' || true",
          "printf '%s\\n' '## descriptors'",
          'for file in /home/kmux/.kmux/state/sessions/*.json; do [ -f "$file" ] || continue; printf \'%s\\n\' "### $file"; cat "$file"; done',
          "printf '%s\\n' '## files'",
          "find /home/kmux/.kmux -maxdepth 6 -type f -printf '%m %s %p\\n' 2>/dev/null | sort | head -1000",
          "printf '%s\\n' '## sshd tail'",
          "tail -200 /var/log/kmux-ssh/sshd.log 2>/dev/null || true"
        ].join("; ")
      ])
      .catch((error: unknown) => ({
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      }))
  ]);

  await test.info().attach("ssh-failure-diagnostics", {
    body: Buffer.from(
      JSON.stringify(
        {
          view,
          connections,
          terminalDom,
          consoleMessages: options.consoleMessages,
          remote
        },
        null,
        2
      )
    ),
    contentType: "application/json"
  });
  if (existsSync(diagnosticsLog)) {
    await test.info().attach("kmux-debug-log", {
      body: readFileSync(diagnosticsLog),
      contentType: "application/x-ndjson"
    });
  }
}

async function waitForSshRestore(
  page: Page,
  predicate: Parameters<typeof waitForView>[1],
  message: string,
  timeoutMs: number
) {
  const startedAt = Date.now();
  let lastState = await getView(page);
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await getView(page);
    if (predicate(lastState)) return lastState;
    const connections = await page.evaluate(async () => {
      const api = (window as unknown as { kmux: SshWorkspaceTestApi }).kmux;
      return await api.getSshConnections();
    });
    const failure = connections.profiles.find(
      (profile) => profile.lastError !== undefined
    );
    if (failure?.lastError) {
      throw new Error(
        `${message}; automatic SSH restore failed for ${failure.name}: ${failure.lastError.message}`
      );
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    `${message}; timeout=${timeoutMs}ms; lastState=${JSON.stringify(lastState)}`
  );
}

function installSshFixtureConfig(
  sandbox: KmuxSandbox,
  fixtureConfigPath: string
): void {
  const sshDirectory = join(sandbox.shellHomeDir, ".ssh");
  mkdirSync(sshDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(sshDirectory, "config"),
    `Include "${fixtureConfigPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`,
    { mode: 0o600 }
  );
}

async function createRemoteWorkspace(
  page: Page,
  hostAlias: string
): Promise<{ workspaceId: string; targetId: string }> {
  return await page.evaluate(async (alias) => {
    const api = (window as unknown as { kmux: SshWorkspaceTestApi }).kmux;
    const state = await api.getShellState();
    const profile = await api.saveSshProfile({
      profile: {
        name: "SSH E2E",
        sshConfigHost: alias,
        defaultRemoteCwd: "/home/kmux",
        forwardAgent: false
      }
    });
    const prepared = await api.prepareSshWorkspace({
      requestId: "ssh_e2e_prepare_1",
      sourceWorkspaceId: state.activeWorkspace.id,
      profileId: profile.id,
      continuation: "convert"
    });
    return await api.commitSshWorkspace({
      preparationId: prepared.preparationId
    });
  }, hostAlias);
}

async function sendMarker(
  page: Page,
  surfaceId: string,
  marker: string
): Promise<void> {
  const screen = committedTerminalHost(page, surfaceId).locator(
    ".xterm-screen"
  );
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await screen.click();
  const input = committedTerminalHost(page, surfaceId).locator(
    "textarea.xterm-helper-textarea"
  );
  await expect(input).toBeFocused({ timeout: 30_000 });
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");
  await expect(committedTerminalRows(page, surfaceId)).toContainText(marker, {
    timeout: 30_000
  });
}

function committedTerminalHost(page: Page, surfaceId: string) {
  return page
    .getByTestId(`terminal-${surfaceId}`)
    .locator(':scope > div:not([data-terminal-hydration-stage="true"])');
}

function committedTerminalRows(page: Page, surfaceId: string) {
  return committedTerminalHost(page, surfaceId).locator(".xterm-rows");
}

async function readKeeperPids(target: {
  exec(command: string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}): Promise<number[]> {
  const result = await target.exec([
    "sh",
    "-lc",
    "pgrep -f '[k]muxd keeper serve' || true"
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`keeper process probe failed: ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .sort((left, right) => left - right);
}
