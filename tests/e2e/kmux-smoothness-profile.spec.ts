import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { expect, test, type Page } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getView,
  kmuxPaths,
  launchKmux,
  sendRpc,
  waitForSurfaceSnapshotContains,
  type LaunchedKmux
} from "./helpers";

const shouldRun = process.env.KMUX_RUN_SMOOTHNESS_PROFILE === "1";

test.skip(!shouldRun, "Set KMUX_RUN_SMOOTHNESS_PROFILE=1 to run profiling");

// Drive the representative agent-output generator with the same node binary that
// runs the test, so it resolves regardless of the sandbox shell's PATH.
const NODE_BIN = process.execPath;
const STREAM_SCRIPT = join(
  kmuxPaths().workspaceRoot,
  "scripts",
  "smoothness-agent-stream.mjs"
);
const DONE_MARKER = "__KMUX_STREAM_DONE__";

interface ProfileSession {
  launched: LaunchedKmux;
  profilePath: string;
}

async function launchForProfile(label: string): Promise<ProfileSession> {
  const profileDir = mkdtempSync(join(tmpdir(), `kmux-smoothness-${label}-`));
  const profilePath = join(profileDir, "smoothness.jsonl");
  console.log(`KMUX smoothness profile [${label}]: ${profilePath}`);

  const launched = await launchKmux(`kmux-e2e-smoothness-${label}-`, {
    env: {
      KMUX_PROFILE_LOG_PATH: profilePath
    }
  });
  return { launched, profilePath };
}

async function resolveActiveSurface(page: Page) {
  const initial = await getView(page);
  const paneId = initial.activeWorkspace.activePaneId;
  return {
    workspaceId: initial.activeWorkspace.id,
    paneId,
    surfaceId: initial.activeWorkspace.panes[paneId].activeSurfaceId
  };
}

async function runAgentStream(
  page: Page,
  surfaceId: string,
  mode: "steady" | "burst",
  options: { frames: number; interval: number; label?: string }
): Promise<void> {
  const labelFlag =
    options.label !== undefined ? ` --label ${options.label}` : "";
  const command =
    `${JSON.stringify(NODE_BIN)} ${JSON.stringify(STREAM_SCRIPT)} ` +
    `--mode ${mode} --frames ${options.frames} --interval ${options.interval}` +
    labelFlag;
  await page.evaluate(
    ({ targetSurfaceId, line }) =>
      window.kmux.sendText(targetSurfaceId, `${line}\r`),
    { targetSurfaceId: surfaceId, line: command }
  );
}

// Steady streaming with no viewport churn: isolates the cost of repainting a
// representative agent "live region" (spinner/progress/status repaints, scrolling
// prose, periodic diff/code blocks). Paced over ~5s so the renderer write
// profiler (which flushes a bucket every ~1000ms) records several samples instead
// of the single teardown sample the old plain-text scenario produced.
test("steady terminal streaming — representative agent output, no resize", async () => {
  const { launched, profilePath } = await launchForProfile("stream");

  try {
    const page = launched.page;
    const { surfaceId } = await resolveActiveSurface(page);
    const terminal = page.getByTestId(`terminal-${surfaceId}`);

    await terminal.click();
    await page.waitForTimeout(300);

    await runAgentStream(page, surfaceId, "steady", {
      frames: 320,
      interval: 16
    });

    await waitForSurfaceSnapshotContains(page, surfaceId, DONE_MARKER, 20_000);

    // ~5s of streaming should flush the 1s renderer write bucket several times.
    await expect
      .poll(() => profileEventCount(profilePath, "terminal.write.bucket"), {
        timeout: 5_000
      })
      .toBeGreaterThanOrEqual(3);
  } finally {
    await closeKmux(launched);
  }
});

// Single large write: a burst of colored prose + diff blocks emitted at once,
// exercising the 64KB output-batcher cap and the worst-case single xterm write.
test("peak burst repaint — single large agent write, no resize", async () => {
  const { launched, profilePath } = await launchForProfile("burst");

  try {
    const page = launched.page;
    const { surfaceId } = await resolveActiveSurface(page);
    const terminal = page.getByTestId(`terminal-${surfaceId}`);

    await terminal.click();
    await page.waitForTimeout(300);

    // Repeat the burst several times (spaced out) so the 1s renderer write bucket
    // captures the peak single-write cost as multiple samples, not one.
    const burstCount = 5;
    for (let index = 0; index < burstCount; index += 1) {
      await runAgentStream(page, surfaceId, "burst", {
        frames: 400,
        interval: 0,
        label: String(index)
      });
      await waitForSurfaceSnapshotContains(
        page,
        surfaceId,
        `${DONE_MARKER}:${index}`,
        15_000
      );
      await page.waitForTimeout(400);
    }

    await expect
      .poll(() => profileEventCount(profilePath, "terminal.write.bucket"), {
        timeout: 5_000
      })
      .toBeGreaterThanOrEqual(3);
  } finally {
    await closeKmux(launched);
  }
});

// Resize + sidebar/notification churn, isolated from heavy streaming: the buffer
// is seeded with representative content first, then left to settle, so the
// resize/fit/reflow durations are not contaminated by concurrent write cost.
test("resize and sidebar churn — isolated from streaming", async () => {
  const { launched, profilePath } = await launchForProfile("resize");

  try {
    const page = launched.page;
    const { workspaceId, surfaceId } = await resolveActiveSurface(page);

    await dispatch(page, {
      type: "settings.update",
      patch: {
        socketMode: "allowAll"
      }
    });

    const terminal = page.getByTestId(`terminal-${surfaceId}`);
    await terminal.click();
    await page.waitForTimeout(300);

    // Seed the buffer so reflow has real content to lay out, then settle.
    await runAgentStream(page, surfaceId, "steady", { frames: 60, interval: 16 });
    await waitForSurfaceSnapshotContains(page, surfaceId, DONE_MARKER, 15_000);
    await page.waitForTimeout(400);

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

function readProfileLines(profilePath: string): string[] {
  try {
    return readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function countProfileLines(profilePath: string): number {
  return readProfileLines(profilePath).length;
}

function profileEventCount(profilePath: string, name: string): number {
  return readProfileLines(profilePath).filter((line) => {
    try {
      return (JSON.parse(line).name as string) === name;
    } catch {
      return false;
    }
  }).length;
}

function profileEventNames(profilePath: string): string[] {
  return [
    ...new Set(
      readProfileLines(profilePath).map((line) => JSON.parse(line).name as string)
    )
  ].sort();
}
