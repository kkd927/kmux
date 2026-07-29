import { terminalSurfaceVmContent } from "@kmux/proto";

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { UsageViewSnapshot } from "@kmux/proto";

import {
  closeKmux,
  createSandbox,
  dispatch,
  getView,
  launchKmux,
  launchKmuxWithSandbox,
  waitForSurfaceSnapshotContains,
  waitForView
} from "./helpers";

test("usage right sidebar stays docked when Escape is pressed and closes only via its toggle", async () => {
  const launched = await launchKmux("kmux-e2e-usage-escape-");

  try {
    const { page } = launched;
    const initialView = await getView(page);
    await dismissReleaseNotes(page);
    const paneId = initialView.activeWorkspace.activePaneId;
    const surfaceId = initialView.activeWorkspace.panes[paneId].activeSurfaceId;
    const terminal = page.getByTestId(`terminal-${surfaceId}`);
    const rightPanel = page.getByTestId("usage-right-panel");

    await terminal.click();
    await page.keyboard.press("Meta+Shift+U");
    await expect(rightPanel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(rightPanel).toBeVisible();

    await page.keyboard.press("Meta+Shift+U");
    await expect(rightPanel).toHaveCount(0);
  } finally {
    await closeKmux(launched);
  }
});

test("manual codex CLI runs show usage only in the right sidebar without a header HUD", async () => {
  const sandbox = createSandbox("kmux-e2e-usage-manual-codex-");
  const usageDir = join(sandbox.profileRoot, "usage", "codex");
  const binDir = join(sandbox.profileRoot, "bin");
  const scriptPath = join(binDir, "codex");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    scriptPath,
    `#!/bin/sh
set -eu
usage_root="\${KMUX_CODEX_USAGE_DIR:?}"
session_dir="$usage_root/$(date +%Y)/$(date +%m)/$(date +%d)"
session_path="$session_dir/manual-codex-session.jsonl"
mkdir -p "$session_dir"
cwd="$(pwd)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat >"$session_path" <<EOF
{"timestamp":"$timestamp","type":"session_meta","payload":{"id":"manual-codex-session","cwd":"$cwd","project_path":"$cwd","model":"gpt-5.4"}}
{"timestamp":"$timestamp","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":512,"cached_input_tokens":128,"output_tokens":32,"total_tokens":544}}}}
EOF
sleep 4
printf 'DONE\\n'
`,
    "utf8"
  );
  chmodSync(scriptPath, 0o755);

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      KMUX_CODEX_USAGE_DIR: usageDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    }
  });

  try {
    const { page } = launched;
    const initialView = await getView(page);
    await dismissReleaseNotes(page);
    const paneId = initialView.activeWorkspace.activePaneId;
    const surfaceId = initialView.activeWorkspace.panes[paneId].activeSurfaceId;
    const terminal = page.getByTestId(`terminal-${surfaceId}`);

    await terminal.click();
    await page.keyboard.type(scriptPath);
    await page.keyboard.press("Enter");

    await waitForUsageView(
      page,
      (snapshot) =>
        snapshot.surfaces[surfaceId]?.vendor === "codex" &&
        snapshot.surfaces[surfaceId]?.attributionState === "bound" &&
        snapshot.surfaces[surfaceId]?.sessionTokens === 544,
      "manual codex execution should become a bound usage surface"
    );

    await expect(page.getByTestId(`usage-hud-${surfaceId}`)).toHaveCount(0);

    await expect(
      page
        .getByRole("button", { name: "Toggle usage dashboard" })
        .locator(".codicon")
    ).toHaveClass(/codicon-layout-sidebar-right/);

    await page.keyboard.press("Meta+Shift+U");
    const dashboard = page.getByTestId("usage-dashboard");
    await expect(dashboard).toBeVisible();
    await expect(dashboard).toContainText("gpt-5.4");
    await expect(dashboard).toContainText("544");

    await waitForSurfaceSnapshotContains(page, surfaceId, "DONE", 8000);
  } finally {
    await closeKmux(launched);
  }
});

test("hook-bound surfaces keep usage details out of the tab header and open a docked right sidebar", async () => {
  const sandbox = createSandbox("kmux-e2e-usage-hud-");
  const usageDir = join(sandbox.profileRoot, "usage", "claude");
  writeUsageFixture(usageDir, [
    buildClaudeUsageRecord({
      sessionId: "claude-bound-1",
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCost: 1.25
    })
  ]);

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      KMUX_CLAUDE_USAGE_DIR: usageDir
    }
  });

  try {
    const { page } = launched;
    const initialUsage = await waitForUsageView(
      page,
      (snapshot) => snapshot.totalTodayCostUsd >= 1.25,
      "initial usage scan should load the claude fixture"
    );
    expect(initialUsage.unattributedTodayCostUsd).toBeGreaterThan(0);

    const initialView = await getView(page);
    await dismissReleaseNotes(page);
    const paneId = initialView.activeWorkspace.activePaneId;
    const surfaceId = initialView.activeWorkspace.panes[paneId].activeSurfaceId;
    const terminal = page.getByTestId(`terminal-${surfaceId}`);

    await dispatch(page, {
      type: "agent.event",
      workspaceId: initialView.activeWorkspace.id,
      paneId,
      surfaceId,
      sessionId: "claude-bound-1",
      agent: "claude",
      event: "session_start"
    });

    await waitForUsageView(
      page,
      (snapshot) => snapshot.surfaces[surfaceId]?.todayCostUsd === 1.25,
      "binding the surface should attribute the usage sample to the active pane"
    );

    const beforeWidth = (await terminal.boundingBox())?.width ?? 0;
    expect(beforeWidth).toBeGreaterThan(0);

    await page.keyboard.press("Meta+Shift+U");

    const rightPanel = page.getByTestId("usage-right-panel");
    const dashboard = page.getByTestId("usage-dashboard");
    await expect(rightPanel).toBeVisible();
    await expect(dashboard).toBeVisible();
    await expect(page.getByTestId(`usage-hud-${surfaceId}`)).toHaveCount(0);

    const afterWidth = (await terminal.boundingBox())?.width ?? 0;
    expect(afterWidth).toBeLessThan(beforeWidth - 150);
  } finally {
    await closeKmux(launched);
  }
});

test("unique cwd usage stays in the dashboard but does not show a pane HUD before an explicit agent hook arrives", async () => {
  const sandbox = createSandbox("kmux-e2e-usage-unbound-");
  const usageDir = join(sandbox.profileRoot, "usage", "claude");
  mkdirSync(usageDir, { recursive: true });

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      KMUX_CLAUDE_USAGE_DIR: usageDir
    }
  });

  try {
    const { page } = launched;
    const view = await getView(page);
    await dismissReleaseNotes(page);
    const activeSurfaceId =
      view.activeWorkspace.panes[view.activeWorkspace.activePaneId]
        .activeSurfaceId;
    const projectPath =
      terminalSurfaceVmContent(view.activeWorkspace.surfaces[activeSurfaceId])
        ?.runtimeMetadata.cwd ?? sandbox.shellHomeDir;

    writeUsageFixture(usageDir, [
      buildClaudeUsageRecord({
        sessionId: "claude-unbound-1",
        inputTokens: 400,
        outputTokens: 90,
        estimatedCost: 0.55,
        projectPath,
        cwd: projectPath
      })
    ]);

    const usageSnapshot = await waitForUsageView(
      page,
      (snapshot) =>
        snapshot.totalTodayCostUsd >= 0.55 &&
        snapshot.surfaces &&
        Object.values(snapshot.surfaces).some(
          (surface) => surface.attributionState === "aggregate_only"
        ),
      "cwd-matched usage should surface as tracked even before an explicit agent hook arrives"
    );
    expect(usageSnapshot.surfaces[activeSurfaceId]?.attributionState).toBe(
      "aggregate_only"
    );

    await page.keyboard.press("Meta+Shift+U");

    const dashboard = page.getByTestId("usage-dashboard");
    await expect(dashboard).toBeVisible();
    await expect(page.getByTestId(`usage-hud-${activeSurfaceId}`)).toHaveCount(
      0
    );
    await expect(dashboard).toContainText("claude-sonnet-4");
    await expect(dashboard).toContainText("$0.55");
  } finally {
    await closeKmux(launched);
  }
});

test("moderate daily spend does not create budget alerts, sidebar statuses, or tab dots", async () => {
  const sandbox = createSandbox("kmux-e2e-usage-alerts-");
  const usageDir = join(sandbox.profileRoot, "usage", "claude");
  writeUsageFixture(usageDir, [
    buildClaudeUsageRecord({
      sessionId: "claude-alert-session",
      inputTokens: 1200,
      outputTokens: 260,
      estimatedCost: 1.25
    })
  ]);

  const launched = await launchKmuxWithSandbox(sandbox, {
    env: {
      KMUX_CLAUDE_USAGE_DIR: usageDir
    }
  });

  try {
    const { page } = launched;
    await waitForUsageView(
      page,
      (snapshot) => snapshot.totalTodayCostUsd >= 1.25,
      "alert fixture should be loaded before binding"
    );

    const initialView = await getView(page);
    await dismissReleaseNotes(page);
    const paneId = initialView.activeWorkspace.activePaneId;
    const surfaceId = initialView.activeWorkspace.panes[paneId].activeSurfaceId;

    await dispatch(page, {
      type: "agent.event",
      workspaceId: initialView.activeWorkspace.id,
      paneId,
      surfaceId,
      sessionId: "claude-alert-session",
      agent: "claude",
      event: "session_start"
    });

    await waitForUsageView(
      page,
      (snapshot) => snapshot.surfaces[surfaceId]?.todayCostUsd === 1.25,
      "binding the usage sample should attribute moderate daily spend to the active surface"
    );

    const quietView = await waitForView(
      page,
      (view) =>
        !view.notifications.some((notification) =>
          notification.message.toLowerCase().includes("budget")
        ) &&
        !view.activeWorkspace.statusEntries.some((entry) =>
          entry.text.toLowerCase().includes("budget")
        ),
      "daily spend totals should stay quiet once budget alerts are removed"
    );

    expect(quietView.activeWorkspace.statusEntries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringMatching(/budget/i)
        })
      ])
    );

    const workspaceCard = page.locator(
      `[data-workspace-id="${initialView.activeWorkspace.id}"]`
    );
    await expect(workspaceCard).not.toContainText(/budget/i);
    await expect(
      page.getByTestId(`surface-alert-dot-${surfaceId}`)
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`surface-unread-badge-${surfaceId}`)
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Toggle notifications" }).click();
    await expect(page.getByText(/budget/i)).toHaveCount(0);
  } finally {
    await closeKmux(launched);
  }
});

function writeUsageFixture(
  usageDir: string,
  records: Array<Record<string, unknown>>
): void {
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(
    join(usageDir, "usage.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
}

function buildClaudeUsageRecord(options: {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  projectPath?: string;
  cwd?: string;
}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: options.sessionId,
    model: "claude-sonnet-4",
    input_tokens: options.inputTokens,
    output_tokens: options.outputTokens,
    estimated_cost: options.estimatedCost,
    ...(options.projectPath ? { project_path: options.projectPath } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {})
  };
}

async function getUsageView(page: Page): Promise<UsageViewSnapshot> {
  return page.evaluate(() =>
    (
      window as unknown as {
        kmux: { getUsageView: () => Promise<UsageViewSnapshot> };
      }
    ).kmux.getUsageView()
  );
}

async function dismissReleaseNotes(page: Page): Promise<void> {
  const overlay = page.getByTestId("release-notes-overlay");
  await overlay
    .waitFor({ state: "visible", timeout: 2_000 })
    .catch(() => undefined);
  if (!(await overlay.isVisible())) {
    return;
  }
  await overlay
    .getByRole("button", { name: "Close release notes" })
    .click();
  await expect(overlay).toHaveCount(0);
}

async function waitForUsageView(
  page: Page,
  predicate: (snapshot: UsageViewSnapshot) => boolean,
  message: string,
  timeoutMs = 5000
): Promise<UsageViewSnapshot> {
  const startTime = Date.now();
  let lastSnapshot: UsageViewSnapshot | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const snapshot = await getUsageView(page);
    if (predicate(snapshot)) {
      return snapshot;
    }
    lastSnapshot = snapshot;
    await page.waitForTimeout(50);
  }

  throw new Error(
    `${message}; timeout=${timeoutMs}ms; lastSnapshot=${JSON.stringify(lastSnapshot)}`
  );
}
