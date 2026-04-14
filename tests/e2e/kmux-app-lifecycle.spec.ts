import process from "node:process";

import { expect, test } from "@playwright/test";

import {
  createSandbox,
  destroySandbox,
  dispatch,
  launchKmuxWithSandbox,
  sendRpc,
  waitForView
} from "./helpers";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }

    throw error;
  }
}

test("closing the last window quits kmux and tears down background services", async () => {
  const sandbox = createSandbox("kmux-e2e-app-close-");
  let launched = await launchKmuxWithSandbox(sandbox);
  let relaunch: Awaited<ReturnType<typeof launchKmuxWithSandbox>> | undefined;

  try {
    const appPid = launched.app.process().pid;
    expect(appPid).toBeTruthy();

    await dispatch(launched.page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll"
      }
    });
    await waitForView(
      launched.page,
      (view) => view.settings.socketMode === "allowAll",
      "socket mode should allow direct RPC before shutdown"
    );

    const pingBeforeClose = await sendRpc<{ pong: boolean }>(
      sandbox.socketPath,
      "system.ping"
    );
    expect(pingBeforeClose.pong).toBe(true);

    const appClose = launched.app.waitForEvent("close");
    await launched.page.evaluate(() => window.kmux.windowControl("close"));
    await appClose;

    await expect
      .poll(async () => {
        try {
          await sendRpc(sandbox.socketPath, "system.ping");
          return "reachable";
        } catch {
          return "closed";
        }
      })
      .toBe("closed");

    if (typeof appPid === "number") {
      await expect
        .poll(() => (isProcessAlive(appPid) ? "alive" : "exited"))
        .toBe("exited");
    }

    relaunch = await launchKmuxWithSandbox(sandbox);
    const restored = await waitForView(
      relaunch.page,
      (view) =>
        view.workspaceRows.length > 0 &&
        view.settings.socketMode === "allowAll",
      "relaunch should stay usable after closing the last window"
    );
    expect(restored.workspaceRows.length).toBeGreaterThan(0);
    expect(restored.settings.socketMode).toBe("allowAll");
  } finally {
    await launched.app.close().catch(() => {});
    if (relaunch) {
      await relaunch.app.close().catch(() => {});
    }
    destroySandbox(sandbox);
  }
});
