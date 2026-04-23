import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  launchKmux,
  sendRpc,
  waitForSurfaceSnapshotContains
} from "./helpers";

const shouldRun = process.env.KMUX_RUN_SMOOTHNESS_PROFILE === "1";

test.skip(!shouldRun, "Set KMUX_RUN_SMOOTHNESS_PROFILE=1 to run profiling");

test("profiles terminal output with sidebar and notification churn", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "kmux-smoothness-profile-"));
  const profilePath = join(profileDir, "smoothness.jsonl");
  console.log(`KMUX smoothness profile: ${profilePath}`);

  const launched = await launchKmux("kmux-e2e-smoothness-profile-", {
    env: {
      KMUX_PROFILE_LOG_PATH: profilePath
    }
  });

  try {
    const page = launched.page;
    const initial = await getView(page);
    const workspaceId = initial.activeWorkspace.id;
    const paneId = initial.activeWorkspace.activePaneId;
    const surfaceId = initial.activeWorkspace.panes[paneId].activeSurfaceId;
    const terminal = page.getByTestId(`terminal-${surfaceId}`);

    await dispatch(page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll"
      }
    });

    await terminal.click();
    await page.waitForTimeout(500);
    await page.evaluate(
      ({ command, targetSurfaceId }) =>
        window.kmux.sendText(targetSurfaceId, `${command}\r`),
      {
        targetSurfaceId: surfaceId,
        command:
          "i=0; while [ $i -lt 1200 ]; do printf \"agent-token-$i %096d\\n\" 0; i=$((i+1)); done"
      }
    );

    for (let index = 0; index < 80; index += 1) {
      if (index % 20 === 0) {
        await page.setViewportSize({
          width: index % 40 === 0 ? 1180 : 960,
          height: index % 40 === 0 ? 820 : 640
        });
      }
      await sendRpc(launched.sandbox.socketPath, "sidebar.log", {
        workspaceId,
        level: "info",
        message: `profile log ${index}`
      });
      await sendRpc(launched.sandbox.socketPath, "sidebar.set_status", {
        workspaceId,
        text: `profile status ${index}`,
        key: "profile"
      });
      if (index % 10 === 0) {
        await sendRpc(launched.sandbox.socketPath, "notification.create", {
          workspaceId,
          surfaceId,
          title: "profile notification",
          message: `notification ${index}`
        });
      }
    }

    await waitForSurfaceSnapshotContains(
      page,
      surfaceId,
      "agent-token-1199",
      15_000
    );

    await expect
      .poll(() => countProfileLines(profilePath), {
        timeout: 10_000
      })
      .toBeGreaterThan(5);
    await expect
      .poll(() => profileEventNames(profilePath), {
        timeout: 10_000
      })
      .toEqual(
        expect.arrayContaining([
          "terminal.fit",
          "terminal.resize.request",
          "terminal.resize.ack",
          "terminal.resize.apply",
          "terminal.reflow"
        ])
      );
  } finally {
    await closeKmux(launched);
  }
});

function countProfileLines(profilePath: string): number {
  try {
    return readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function profileEventNames(profilePath: string): string[] {
  try {
    return [
      ...new Set(
        readFileSync(profilePath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).name as string)
      )
    ].sort();
  } catch {
    return [];
  }
}
