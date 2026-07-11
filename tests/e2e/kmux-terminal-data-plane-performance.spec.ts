import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { expect, test, type Page } from "@playwright/test";

import {
  closeKmux,
  dispatch,
  getSurfaceSnapshot,
  getView,
  kmuxPaths,
  launchKmux,
  waitForSurfaceSnapshotContains
} from "./helpers";

const shouldRun = process.env.KMUX_RUN_TERMINAL_DATA_PLANE_GATE === "1";
test.skip(
  !shouldRun,
  "Set KMUX_RUN_TERMINAL_DATA_PLANE_GATE=1 to run the 16-session data-plane gate"
);

const NODE_BIN = process.execPath;
const LOAD_SCRIPT = join(
  kmuxPaths().workspaceRoot,
  "scripts",
  "terminal-data-plane-load.mjs"
);
const QUEUE_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024;
const QUEUE_LOW_WATERMARK_BYTES = 1 * 1024 * 1024;
const RING_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const RING_MAX_SESSION_EVENTS = 2_048;
const RING_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const RING_MAX_TOTAL_EVENTS = 65_536;
const ATTACH_INITIAL_CREDIT_BYTES = 128 * 1024;
const ATTACH_MAX_OUTSTANDING_OUTPUT_BYTES = 64 * 1024;
const MAX_LIVE_ATTACHMENTS = 4;
const MAX_TOTAL_CACHED_TERMINALS = 8;

test("16 sessions / 4 visible stay bounded and responsive", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const profileDir = mkdtempSync(join(tmpdir(), "kmux-data-plane-gate-"));
  const profilePath = join(profileDir, "profile.jsonl");
  const launched = await launchKmux("kmux-e2e-data-plane-gate-", {
    env: {
      KMUX_PROFILE_LOG_PATH: profilePath
    }
  });

  try {
    const { page } = launched;
    const workspaces: Array<{
      id: string;
      surfaceIds: string[];
      probeSurfaceId: string;
    }> = [];
    for (let workspaceIndex = 0; workspaceIndex < 4; workspaceIndex += 1) {
      let view =
        workspaceIndex === 0
          ? await getView(page)
          : await dispatch(page, {
              type: "workspace.create",
              name: `load-${workspaceIndex + 1}`
            });
      for (let splitIndex = 0; splitIndex < 3; splitIndex += 1) {
        view = await dispatch(page, {
          type: "pane.split",
          paneId: view.activeWorkspace.activePaneId,
          direction: splitIndex % 2 === 0 ? "right" : "down"
        });
      }
      const surfaceIds = Object.values(view.activeWorkspace.panes).map(
        (pane) => pane.activeSurfaceId
      );
      const probeSurfaceId =
        view.activeWorkspace.panes[view.activeWorkspace.activePaneId]!
          .activeSurfaceId;
      workspaces.push({
        id: view.activeWorkspace.id,
        surfaceIds,
        probeSurfaceId
      });
    }
    expect(
      workspaces.flatMap((workspace) => workspace.surfaceIds)
    ).toHaveLength(16);

    for (const [workspaceIndex, workspace] of workspaces.entries()) {
      for (const [surfaceIndex, surfaceId] of workspace.surfaceIds.entries()) {
        const label = `${workspaceIndex}-${surfaceIndex}`;
        const command =
          `${JSON.stringify(NODE_BIN)} ${JSON.stringify(LOAD_SCRIPT)} ` +
          `--duration 90000 --interval 50 --bytes 1024 --label ${label}`;
        await page.evaluate(
          ({ targetSurfaceId, line }) =>
            window.kmux.sendText(targetSurfaceId, `${line}\r`),
          { targetSurfaceId: surfaceId, line: command }
        );
      }
    }

    const measuredWorkspaces = workspaces.slice(0, 2);
    for (const workspace of measuredWorkspaces) {
      await dispatch(page, {
        type: "workspace.select",
        workspaceId: workspace.id
      });
      await expect(page.locator("[data-pane-id]:visible")).toHaveCount(4);
      for (const surfaceId of workspace.surfaceIds) {
        await waitForTerminalAttachCatchUp(page, surfaceId, 2_000);
      }
      await waitForTerminalInputReady(page, workspace.probeSurfaceId, 1_000);
      await waitForTerminalStreamReady(page, workspace.probeSurfaceId, 1_000);
      const warmInputStartedAt = await page.evaluate(() => performance.now());
      await injectTerminalUserInput(
        page,
        workspace.probeSurfaceId,
        "echo-probe-warmup\r"
      );
      await waitForTerminalPaintAfter(
        page,
        workspace.probeSurfaceId,
        warmInputStartedAt,
        1_000
      );
    }
    await page.waitForTimeout(150);

    const workloadRendererStartedAt = await page.evaluate(() =>
      performance.now()
    );
    const warmPaintLatencies: number[] = [];
    const echoLatencies: number[] = [];
    const workloadStartedAt = Date.now();
    for (let switchIndex = 0; switchIndex < 15; switchIndex += 1) {
      const cycleStartedAt = Date.now();
      const workspace = measuredWorkspaces[switchIndex % 2]!;
      const warmPaintPromise = measureVisibleTerminalFrame(
        page,
        workspace.surfaceIds[0]!
      );
      await dispatch(page, {
        type: "workspace.select",
        workspaceId: workspace.id
      });
      await expect(page.locator("[data-pane-id]:visible")).toHaveCount(4);
      warmPaintLatencies.push(await warmPaintPromise);

      for (const visibleSurfaceId of workspace.surfaceIds) {
        await waitForTerminalAttachCatchUp(page, visibleSurfaceId, 2_000);
      }
      await waitForTerminalInputReady(page, workspace.probeSurfaceId, 1_000);
      await waitForTerminalStreamReady(page, workspace.probeSurfaceId, 1_000);
      await page.waitForTimeout(200);
      const surfaceId = workspace.probeSurfaceId;
      for (let probeIndex = 0; probeIndex < 3; probeIndex += 1) {
        const probe = `echo-probe-${switchIndex}-${probeIndex}`;
        const expectedEcho = `[kmux-echo:${probe}]`;
        await startTerminalEchoFrameMonitor(
          page,
          surfaceId,
          expectedEcho,
          echoProbeToken(probe)
        );
        await injectTerminalUserInput(page, surfaceId, `${probe}\r`);
        echoLatencies.push(
          await waitForTerminalEchoFrameMonitor(
            page,
            surfaceId,
            expectedEcho,
            1_000
          )
        );
        if (probeIndex < 2) {
          await page.waitForTimeout(30);
        }
      }

      const remaining = 2_000 - (Date.now() - cycleStartedAt);
      if (remaining > 0) {
        await page.waitForTimeout(remaining);
      }
    }
    expect(Date.now() - workloadStartedAt).toBeGreaterThanOrEqual(29_000);

    await page.waitForTimeout(1_200);
    const events = readProfile(profilePath);
    const allRenderEvents = events.filter(
      (event) =>
        event.name === "terminal.data-plane.render" &&
        event.at >= workloadRendererStartedAt
    );
    const droppedRenderEvents = allRenderEvents.filter(
      (event) => event.details.renderMetricDropped === true
    );
    const renderEvents = allRenderEvents.filter(
      (event) => event.details.renderMetricDropped !== true
    );
    const visibleRenderEvents = renderEvents.filter(
      (event) => event.details.visibleAtPtyRead === true
    );
    const renderLatencies = detailValues(
      visibleRenderEvents,
      "ptyReadToRenderMs"
    );
    const parsedEvents = events.filter(
      (event) =>
        event.name === "terminal.data-plane.parsed" &&
        event.at >= workloadRendererStartedAt
    );
    const parsedInputEvents = parsedEvents.filter(
      (event) =>
        Number.isFinite(Number(event.details.inputAcceptedAt)) &&
        Number.isFinite(Number(event.details.inputSequence))
    );
    const plainSchedulerDelays = parsedEvents
      .filter((event) => event.details.presentation === "plain")
      .map((event) => Number(event.details.schedulerAddedDelayMs))
      .filter(Number.isFinite);
    const paintIntervals = events
      .filter(
        (event) =>
          event.name === "terminal.data-plane.paint" &&
          event.at >= workloadRendererStartedAt
      )
      .flatMap((event) =>
        Array.isArray(event.details.intervalsMs)
          ? event.details.intervalsMs.map(Number)
          : []
      )
      .filter(Number.isFinite);
    const supervisor = events
      .filter((event) => event.name === "terminal.data-plane.supervisor")
      .slice(-30);
    const terminalCache = await page.evaluate(() =>
      window.__kmuxTerminalCacheDiagnostics?.()
    );

    expect(renderLatencies.length).toBeGreaterThan(100);
    expect(echoLatencies.length).toBeGreaterThanOrEqual(45);
    expect(parsedInputEvents.length).toBeGreaterThanOrEqual(45);
    expect(plainSchedulerDelays.length).toBeGreaterThan(100);
    expect(paintIntervals.length).toBeGreaterThan(100);
    expect(droppedRenderEvents).toHaveLength(0);
    expect(
      Math.max(
        0,
        ...allRenderEvents.map((event) =>
          Number(event.details.renderMetricOverflowCount ?? 0)
        )
      )
    ).toBe(0);
    expect(
      percentile(echoLatencies, 95),
      `steady echo latencies: ${echoLatencies.map((value) => value.toFixed(1)).join(", ")}`
    ).toBeLessThanOrEqual(75);
    expect(percentile(echoLatencies, 99)).toBeLessThanOrEqual(150);
    expect(percentile(renderLatencies, 95)).toBeLessThanOrEqual(100);
    expect(percentile(renderLatencies, 99)).toBeLessThanOrEqual(250);
    expect(percentile(paintIntervals, 95)).toBeLessThanOrEqual(50);
    expect(Math.max(0, ...plainSchedulerDelays)).toBeLessThanOrEqual(32);
    expect(Math.max(...warmPaintLatencies)).toBeLessThanOrEqual(100);
    expect(
      percentile(detailValues(supervisor, "eventLoopDelayP95Ms"), 95)
    ).toBeLessThanOrEqual(20);
    assertSupervisorBounds(supervisor);
    expect(terminalCache).toMatchObject({
      boundViolationCount: 0,
      maxWarmTerminals: 4,
      maxWarmBufferCells: 4_000_000
    });
    expect(
      terminalCache?.peakWarmTerminals ?? Number.POSITIVE_INFINITY
    ).toBeLessThanOrEqual(terminalCache?.maxWarmTerminals ?? 0);
    expect(
      terminalCache?.peakWarmBufferCells ?? Number.POSITIVE_INFINITY
    ).toBeLessThanOrEqual(terminalCache?.maxWarmBufferCells ?? 0);
    expect(terminalCache?.visibleTerminals).toBe(4);
    expect(
      terminalCache?.totalTerminals ?? Number.POSITIVE_INFINITY
    ).toBeLessThanOrEqual(MAX_TOTAL_CACHED_TERMINALS);
    expect(
      events.filter(
        (event) => event.name === "terminal.data-plane.main-ingress"
      )
    ).toHaveLength(0);
    expect(
      events
        .filter((event) => event.name === "terminal.ipc.bucket")
        .reduce((total, event) => total + Number(event.details.bytes ?? 0), 0)
    ).toBe(0);
    const metrics = {
      echoP95Ms: percentile(echoLatencies, 95),
      echoP99Ms: percentile(echoLatencies, 99),
      renderP95Ms: percentile(renderLatencies, 95),
      renderP99Ms: percentile(renderLatencies, 99),
      paintP95Ms: percentile(paintIntervals, 95),
      schedulerMaxMs: Math.max(0, ...plainSchedulerDelays),
      eventLoopP95Ms: percentile(
        detailValues(supervisor, "eventLoopDelayP95Ms"),
        95
      ),
      warmSwitchMaxMs: Math.max(...warmPaintLatencies),
      cacheBoundViolations: terminalCache?.boundViolationCount ?? null,
      supervisorBoundViolations: Math.max(
        0,
        ...supervisor.flatMap((event) => [
          Number(event.details.creditBoundViolationCount ?? 0),
          Number(event.details.ringBoundViolationCount ?? 0)
        ])
      )
    };
    await testInfo.attach("steady-data-plane-metrics.json", {
      body: Buffer.from(JSON.stringify(metrics, null, 2)),
      contentType: "application/json"
    });
    console.log(`[kmux-steady-metrics] ${JSON.stringify(metrics)}`);
  } finally {
    await closeKmux(launched);
  }
});

test("4 MiB burst preserves input echo and catches up within two seconds", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const launched = await launchKmux("kmux-e2e-data-plane-burst-");
  try {
    const { page } = launched;
    const view = await getView(page);
    const surfaceId =
      view.activeWorkspace.panes[view.activeWorkspace.activePaneId]
        .activeSurfaceId;
    const marker = "[kmux-burst-done:burst:";
    const command =
      `${JSON.stringify(NODE_BIN)} ${JSON.stringify(LOAD_SCRIPT)} ` +
      "--burst-bytes 4194304 --label burst --tail-lines 64 " +
      "--burst-chunk-delay 20 --echo-pause 100 --start-delay 500 " +
      "--burst-start-on-input 1";
    await waitForTerminalInputReady(page, surfaceId, 2_000);
    await waitForTerminalStreamReady(page, surfaceId, 2_000);
    await page.evaluate(
      ({ targetSurfaceId, line }) =>
        window.kmux.sendText(targetSurfaceId, `${line}\r`),
      { targetSurfaceId: surfaceId, line: command }
    );
    await waitForRendererBufferContains(
      page,
      surfaceId,
      "[kmux-load-ready:burst]",
      10_000
    );
    await waitForRendererBufferContains(
      page,
      surfaceId,
      "[kmux-burst-start:burst]",
      10_000
    );

    const warmupProbe = "b00";
    const warmupMarker = `[kmux-echo-state:burst:${warmupProbe}:pending:`;
    await startTerminalEchoFrameMonitor(
      page,
      surfaceId,
      warmupMarker,
      echoProbeToken(warmupProbe)
    );
    await injectTerminalUserInput(page, surfaceId, `${warmupProbe}\r`);
    await waitForTerminalEchoFrameMonitor(page, surfaceId, warmupMarker, 1_000);
    await waitForRendererBufferContains(
      page,
      surfaceId,
      "[kmux-burst-active:burst]",
      10_000
    );

    const echoLatencies: number[] = [];
    for (let probeIndex = 0; probeIndex < 20; probeIndex += 1) {
      const probe = `b${String(probeIndex + 1).padStart(2, "0")}`;
      await startTerminalEchoFrameMonitor(
        page,
        surfaceId,
        `[kmux-echo-state:burst:${probe}:pending:`,
        echoProbeToken(probe)
      );
      await injectTerminalUserInput(page, surfaceId, `${probe}\r`);
      echoLatencies.push(
        await waitForTerminalEchoFrameMonitor(
          page,
          surfaceId,
          `[kmux-echo-state:burst:${probe}:pending:`,
          1_000
        )
      );
    }
    const echoP95Ms = percentile(echoLatencies, 95);
    const echoP99Ms = percentile(echoLatencies, 99);
    expect(
      echoP95Ms,
      `burst echo latencies: ${echoLatencies.map((value) => value.toFixed(1)).join(", ")}`
    ).toBeLessThanOrEqual(100);

    await waitForSurfaceSnapshotContains(page, surfaceId, marker, 60_000);
    const snapshot = await getSurfaceSnapshot(page, surfaceId);
    expect(snapshot?.sequence).toEqual(expect.any(Number));
    const producerFinishedAt = Number(
      snapshot?.vt.match(/\[kmux-burst-done:burst:(\d+)\]/)?.[1]
    );
    expect(Number.isFinite(producerFinishedAt)).toBe(true);
    await waitForRenderedSequence(
      page,
      surfaceId,
      2_000,
      snapshot?.sequence ?? 0
    );
    const expectedTail = extractTailTokens(snapshot?.vt ?? "", "burst");
    expect(expectedTail).toHaveLength(64);
    await waitForRendererBufferContains(
      page,
      surfaceId,
      expectedTail.at(-1)!,
      2_000
    );
    const rendererState = await readRendererTerminalState(page, surfaceId);
    expect(extractTailTokens(rendererState.text, "burst")).toEqual(
      expectedTail
    );
    expect(countOccurrences(snapshot?.vt ?? "", marker)).toBe(1);
    expect(countOccurrences(rendererState.text, marker)).toBe(1);
    const catchUpElapsedMs = Date.now() - producerFinishedAt;
    expect(catchUpElapsedMs).toBeLessThanOrEqual(2_000);
    const metrics = { echoP95Ms, echoP99Ms, catchUpElapsedMs };
    await testInfo.attach("burst-metrics.json", {
      body: Buffer.from(JSON.stringify(metrics, null, 2)),
      contentType: "application/json"
    });
    console.log(`[kmux-burst-metrics] ${JSON.stringify(metrics)}`);
  } finally {
    await closeKmux(launched);
  }
});

test("ring gap swaps a complete alternate-screen checkpoint without a blank frame", async () => {
  test.setTimeout(30_000);
  const profileDir = mkdtempSync(join(tmpdir(), "kmux-ring-gap-gate-"));
  const profilePath = join(profileDir, "profile.jsonl");
  const launched = await launchKmux("kmux-e2e-ring-gap-gate-", {
    env: {
      KMUX_PROFILE_LOG_PATH: profilePath
    }
  });

  try {
    const { page } = launched;
    const initial = await getView(page);
    const targetWorkspaceId = initial.activeWorkspace.id;
    const targetSurfaceId =
      initial.activeWorkspace.panes[initial.activeWorkspace.activePaneId]
        .activeSurfaceId;
    const label = "ring-gap";
    const doneMarker = `[kmux-burst-done:${label}:`;
    const finalMarker = `[kmux-tui-final:${label}]`;
    const command =
      `${JSON.stringify(NODE_BIN)} ${JSON.stringify(LOAD_SCRIPT)} ` +
      `--burst-bytes 3145728 --label ${label} --start-delay 1500 ` +
      "--tail-lines 8 --mode tui";
    await page.evaluate(
      ({ surfaceId, line }) => window.kmux.sendText(surfaceId, `${line}\r`),
      { surfaceId: targetSurfaceId, line: command }
    );
    await waitForRendererBufferContains(
      page,
      targetSurfaceId,
      `[kmux-load-ready:${label}]`,
      1_000
    );
    // Initial attach and fit can still have a resize mutation in flight when
    // the ready marker first parses. Detach only after that settles so this
    // test exercises a warm resume that genuinely falls behind the ring.
    await page.waitForTimeout(250);

    const fallback = await dispatch(page, {
      type: "workspace.create",
      name: "ring-gap-fallback"
    });
    expect(fallback.activeWorkspace.id).not.toBe(targetWorkspaceId);
    const warmDiagnostics = await page.evaluate(
      (surfaceId) => window.__kmuxTerminalStoreDiagnostics?.(surfaceId),
      targetSurfaceId
    );
    expect(warmDiagnostics?.lastHydratedSurfaceId).toBe(targetSurfaceId);
    expect(warmDiagnostics?.lastHydratedSurfaceSequence).toEqual(
      expect.any(Number)
    );

    await waitForSurfaceSnapshotContains(
      page,
      targetSurfaceId,
      doneMarker,
      10_000
    );
    const authoritative = await getSurfaceSnapshot(page, targetSurfaceId);
    expect(authoritative?.vt).toContain(finalMarker);
    const authoritativeTail = extractTailTokens(authoritative?.vt ?? "", label);
    expect(authoritativeTail).toHaveLength(8);

    await startTerminalFrameMonitor(page, targetSurfaceId, finalMarker);
    await dispatch(page, {
      type: "workspace.select",
      workspaceId: targetWorkspaceId
    });
    const frameMonitor = await waitForTerminalFrameMonitor(page, 2_000);
    expect(frameMonitor.sawTerminal).toBe(true);
    expect(frameMonitor.completed).toBe(true);
    expect(frameMonitor.blankFrames).toBe(0);
    expect(frameMonitor.totalMs).toBeLessThanOrEqual(500);
    expect(frameMonitor.replacementMs).toBeLessThanOrEqual(500);

    const rendererState = await readRendererTerminalState(
      page,
      targetSurfaceId
    );
    expect(rendererState.bufferType).toBe("alternate");
    expect(extractTailTokens(rendererState.text, label)).toEqual(
      authoritativeTail
    );
    for (const marker of [
      finalMarker,
      `[kmux-tui-stable:${label}:alpha]`,
      `[kmux-tui-stable:${label}:beta]`,
      doneMarker
    ]) {
      expect(countOccurrences(authoritative?.vt ?? "", marker)).toBe(1);
      expect(countOccurrences(rendererState.text, marker)).toBe(1);
    }

    await expect
      .poll(
        () =>
          readProfile(profilePath).filter(
            (event) =>
              event.name === "terminal.data-plane.resync" &&
              event.details.surfaceId === targetSurfaceId
          ),
        { timeout: 2_000 }
      )
      .not.toHaveLength(0);
    const resyncEvents = readProfile(profilePath).filter(
      (event) =>
        event.name === "terminal.data-plane.resync" &&
        event.details.surfaceId === targetSurfaceId
    );
    expect(
      Math.max(...resyncEvents.map((event) => Number(event.details.durationMs)))
    ).toBeLessThanOrEqual(500);
    expect(
      resyncEvents.every(
        (event) => Number(event.details.swapGeneration ?? 0) > 0
      )
    ).toBe(true);
  } finally {
    await closeKmux(launched);
  }
});

interface ProfileEvent {
  source?: string;
  name: string;
  at: number;
  details: Record<string, unknown>;
}

function readProfile(path: string): ProfileEvent[] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProfileEvent);
  } catch {
    return [];
  }
}

function detailValues(events: ProfileEvent[], key: string): number[] {
  return events
    .map((event) => Number(event.details[key]))
    .filter(Number.isFinite);
}

async function waitForRendererBufferContains(
  page: Page,
  surfaceId: string,
  expected: string,
  timeout: number
): Promise<void> {
  const terminal = page.getByTestId(`terminal-${surfaceId}`);
  await expect
    .poll(
      () =>
        terminal.evaluate((element, needle) => {
          const xterm = (
            element as Element & {
              __kmuxTerminal?: {
                buffer: {
                  active: {
                    length: number;
                    getLine(
                      index: number
                    ):
                      | { translateToString(trimRight?: boolean): string }
                      | undefined;
                  };
                };
              };
            }
          ).__kmuxTerminal;
          const buffer = xterm?.buffer.active;
          if (!buffer) {
            return false;
          }
          // A single legal 64 KiB source segment can wrap beyond 512 rows.
          // Search the restore-sized recent window so a rendered input echo
          // remains observable without pausing the burst producer.
          const firstLine = Math.max(0, buffer.length - 8_000);
          for (let index = buffer.length - 1; index >= firstLine; index -= 1) {
            if (
              (buffer.getLine(index)?.translateToString(true) ?? "").includes(
                needle
              )
            ) {
              return true;
            }
          }
          return false;
        }, expected),
      { timeout, intervals: [5, 10, 20, 20] }
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

interface RendererTerminalState {
  text: string;
  bufferType: string | null;
}

async function readRendererTerminalState(
  page: Page,
  surfaceId: string
): Promise<RendererTerminalState> {
  return page.getByTestId(`terminal-${surfaceId}`).evaluate((element) => {
    const xterm = (
      element as Element & {
        __kmuxTerminal?: {
          buffer: {
            active: {
              type?: string;
              length: number;
              getLine(index: number):
                | {
                    isWrapped?: boolean;
                    translateToString(trimRight?: boolean): string;
                  }
                | undefined;
            };
          };
        };
      }
    ).__kmuxTerminal;
    const buffer = xterm?.buffer.active;
    if (!buffer) {
      return { text: "", bufferType: null };
    }
    const firstLine = Math.max(0, buffer.length - 512);
    let text = "";
    for (let index = firstLine; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (index > firstLine && !line?.isWrapped) {
        text += "\n";
      }
      text += line?.translateToString(true) ?? "";
    }
    return { text, bufferType: buffer.type ?? null };
  });
}

async function waitForTerminalPaintAfter(
  page: Page,
  surfaceId: string,
  startedAt: number,
  timeout = 1_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const value = await page
          .getByTestId(`terminal-${surfaceId}`)
          .getAttribute("data-terminal-last-on-render-at");
        const onRenderAt = Number(value);
        return Number.isFinite(onRenderAt) && onRenderAt >= startedAt
          ? onRenderAt
          : null;
      },
      { timeout }
    )
    .not.toBeNull();
}

async function measureVisibleTerminalFrame(
  page: Page,
  surfaceId: string
): Promise<number> {
  return page.evaluate(
    (targetSurfaceId) =>
      new Promise<number>((resolve) => {
        const testId = `terminal-${targetSurfaceId}`;
        const waitForFrame = (): void => {
          const element = Array.from(
            document.querySelectorAll<HTMLElement>("[data-testid]")
          ).find((candidate) => candidate.dataset.testid === testId);
          const rect = element?.getBoundingClientRect();
          if (
            element?.isConnected &&
            rect &&
            rect.width > 0 &&
            rect.height > 0
          ) {
            const publishedAt = window.__kmuxLastShellPublishAt;
            requestAnimationFrame(() =>
              resolve(
                typeof publishedAt === "number"
                  ? performance.now() - publishedAt
                  : Number.POSITIVE_INFINITY
              )
            );
            return;
          }
          requestAnimationFrame(waitForFrame);
        };
        waitForFrame();
      }),
    surfaceId
  );
}

async function waitForTerminalAttachCatchUp(
  page: Page,
  surfaceId: string,
  timeout: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const root = page.getByTestId(`terminal-${surfaceId}`);
        const [availableValue, renderedValue] = await Promise.all([
          root.getAttribute("data-terminal-attach-available-sequence"),
          root.getAttribute("data-terminal-rendered-sequence")
        ]);
        const available = Number(availableValue);
        const rendered = Number(renderedValue);
        return (
          Number.isSafeInteger(available) &&
          available >= 0 &&
          Number.isSafeInteger(rendered) &&
          rendered >= available
        );
      },
      { timeout, intervals: [5, 10, 20, 50] }
    )
    .toBe(true);
}

async function waitForTerminalInputReady(
  page: Page,
  surfaceId: string,
  timeout: number
): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId(`terminal-${surfaceId}`)
          .getAttribute("data-terminal-input-ready"),
      { timeout, intervals: [5, 10, 20] }
    )
    .toBe("true");
}

async function waitForTerminalStreamReady(
  page: Page,
  surfaceId: string,
  timeout: number
): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId(`terminal-${surfaceId}`)
          .getAttribute("data-terminal-stream-ready"),
      { timeout, intervals: [5, 10, 20] }
    )
    .toMatch(/^attach_/);
}

interface TerminalEchoFrameMonitorState {
  done: boolean;
  startedAt: number;
  renderedAt: number | null;
}

function echoProbeToken(probe: string): string {
  return Buffer.from(probe, "utf8").toString("base64url");
}

async function injectTerminalUserInput(
  page: Page,
  surfaceId: string,
  data: string
): Promise<void> {
  await page.evaluate(
    ({ targetSurfaceId, input }) => {
      type TerminalRoot = HTMLElement & {
        __kmuxTerminal?: {
          focus(): void;
          input(data: string, wasUserInput?: boolean): void;
        };
      };
      const root = document.querySelector<TerminalRoot>(
        `[data-testid="terminal-${CSS.escape(targetSurfaceId)}"]`
      );
      if (!root?.__kmuxTerminal) {
        throw new Error(`terminal unavailable: ${targetSurfaceId}`);
      }
      // xterm's public user-input API emits the same onData event as the
      // helper textarea, but preserves this deterministic probe as one input
      // mutation so the gate measures kmux rather than Playwright key pacing.
      root.__kmuxTerminal.focus();
      root.__kmuxTerminal.input(input, true);
    },
    { targetSurfaceId: surfaceId, input: data }
  );
}

async function startTerminalEchoFrameMonitor(
  page: Page,
  surfaceId: string,
  expected: string,
  probeToken: string
): Promise<void> {
  await page.evaluate(
    ({ targetSurfaceId, marker, token }) => {
      type MonitorWindow = Window & {
        __kmuxTerminalEchoFrameMonitor?: TerminalEchoFrameMonitorState;
        __kmuxTerminalEchoFrameMonitorCleanup?: () => void;
      };
      type Disposable = { dispose(): void };
      type TerminalRoot = HTMLElement & {
        __kmuxTerminal?: {
          parser: {
            registerOscHandler(
              ident: number,
              callback: (data: string) => boolean
            ): Disposable;
          };
          onRender(callback: () => void): Disposable;
          onWriteParsed(callback: () => void): Disposable;
          buffer: {
            active: {
              length: number;
              getLine(
                index: number
              ): { translateToString(trimRight?: boolean): string } | undefined;
            };
          };
        };
      };
      const monitorWindow = window as MonitorWindow;
      monitorWindow.__kmuxTerminalEchoFrameMonitorCleanup?.();
      const root = document.querySelector<TerminalRoot>(
        `[data-testid="terminal-${CSS.escape(targetSurfaceId)}"]`
      );
      const terminal = root?.__kmuxTerminal;
      if (!terminal) {
        throw new Error(`terminal unavailable: ${targetSurfaceId}`);
      }
      const state: TerminalEchoFrameMonitorState = {
        done: false,
        startedAt: performance.now(),
        renderedAt: null
      };
      monitorWindow.__kmuxTerminalEchoFrameMonitor = state;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let parsedProbe = false;
      let oscDisposable: Disposable | null = null;
      let renderDisposable: Disposable | null = null;
      let writeParsedDisposable: Disposable | null = null;
      let paintFallbackFrame: number | null = null;
      const cleanup = (): void => {
        oscDisposable?.dispose();
        oscDisposable = null;
        renderDisposable?.dispose();
        renderDisposable = null;
        writeParsedDisposable?.dispose();
        writeParsedDisposable = null;
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (paintFallbackFrame !== null) {
          cancelAnimationFrame(paintFallbackFrame);
          paintFallbackFrame = null;
        }
        if (monitorWindow.__kmuxTerminalEchoFrameMonitorCleanup === cleanup) {
          delete monitorWindow.__kmuxTerminalEchoFrameMonitorCleanup;
        }
      };
      const finish = (renderedAt: number | null): void => {
        if (state.done) {
          return;
        }
        state.renderedAt = renderedAt;
        state.done = true;
        cleanup();
      };
      const markProbeParsed = (): void => {
        if (parsedProbe) {
          return;
        }
        parsedProbe = true;
        // xterm can emit onRender before its write-parsed callback. Keep an
        // rAF fallback so a final write before detach/idle still contributes
        // one real browser paint boundary instead of being reported missing.
        paintFallbackFrame = requestAnimationFrame(() => {
          paintFallbackFrame = requestAnimationFrame(() => {
            paintFallbackFrame = null;
            finish(performance.now());
          });
        });
      };
      oscDisposable = terminal.parser.registerOscHandler(515, (data) => {
        if (data === token) {
          markProbeParsed();
        }
        return true;
      });
      writeParsedDisposable = terminal.onWriteParsed(() => {
        if (parsedProbe) {
          return;
        }
        const buffer = terminal.buffer.active;
        let tail = "";
        for (
          let index = Math.max(0, buffer.length - 2_048);
          index < buffer.length;
          index += 1
        ) {
          tail += buffer.getLine(index)?.translateToString(true) ?? "";
        }
        if (tail.includes(marker)) {
          markProbeParsed();
        }
      });
      renderDisposable = terminal.onRender(() => {
        if (parsedProbe) {
          finish(performance.now());
        }
      });
      monitorWindow.__kmuxTerminalEchoFrameMonitorCleanup = cleanup;
      timeoutHandle = setTimeout(() => finish(null), 1_000);
    },
    { targetSurfaceId: surfaceId, marker: expected, token: probeToken }
  );
}

async function waitForTerminalEchoFrameMonitor(
  page: Page,
  surfaceId: string,
  expected: string,
  timeout: number
): Promise<number> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __kmuxTerminalEchoFrameMonitor?: TerminalEchoFrameMonitorState;
              }
            ).__kmuxTerminalEchoFrameMonitor?.done ?? false
        ),
      // The monitor itself enforces the one-second acceptance window. Leave
      // enough outer time for one final rAF under load so failures can report
      // the captured attach/render diagnostics instead of a poll race.
      { timeout: timeout + 1_000, intervals: [5, 10, 20, 20] }
    )
    .toBe(true);
  const state = await page.evaluate(() => {
    const state = (
      window as Window & {
        __kmuxTerminalEchoFrameMonitor?: TerminalEchoFrameMonitorState;
      }
    ).__kmuxTerminalEchoFrameMonitor;
    return state
      ? {
          done: state.done,
          startedAt: state.startedAt,
          renderedAt: state.renderedAt
        }
      : null;
  });
  if (!state || state.renderedAt === null) {
    const diagnostics = await page.evaluate(
      ({ targetSurfaceId, marker }) => {
        type TerminalRoot = HTMLElement & {
          __kmuxTerminal?: {
            buffer: {
              active: {
                length: number;
                getLine(
                  index: number
                ):
                  | { translateToString(trimRight?: boolean): string }
                  | undefined;
              };
            };
          };
        };
        const root = document.querySelector<TerminalRoot>(
          `[data-testid="terminal-${CSS.escape(targetSurfaceId)}"]`
        );
        const buffer = root?.__kmuxTerminal?.buffer.active;
        const lines: string[] = [];
        if (buffer) {
          for (
            let index = Math.max(0, buffer.length - 200);
            index < buffer.length;
            index += 1
          ) {
            lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
          }
        }
        return {
          markerInBuffer: lines.join("\n").includes(marker),
          recentEchoLines: lines
            .filter((line) => line.includes("[kmux-echo"))
            .slice(-5),
          terminalPresent: Boolean(root?.__kmuxTerminal),
          lastOnRenderAt: root?.dataset.terminalLastOnRenderAt ?? null,
          renderGeneration: root?.dataset.terminalRenderGeneration ?? null,
          hydratedSequence: root?.dataset.terminalHydratedSequence ?? null,
          renderedSequence: root?.dataset.terminalRenderedSequence ?? null,
          inputReady: root?.dataset.terminalInputReady ?? null,
          streamReady: root?.dataset.terminalStreamReady ?? null,
          lastInputRoute: root?.dataset.terminalLastInputRoute ?? null,
          lastInputBytes: root?.dataset.terminalLastInputBytes ?? null,
          store:
            window.__kmuxTerminalStoreDiagnostics?.(targetSurfaceId) ?? null
        };
      },
      { targetSurfaceId: surfaceId, marker: expected }
    );
    const authoritative = await getSurfaceSnapshot(page, surfaceId);
    const authoritativeEchoLines = (authoritative?.vt ?? "")
      .split("\n")
      .filter((line) => line.includes("[kmux-echo"))
      .slice(-5);
    throw new Error(
      `terminal echo marker was not painted before timeout: ${JSON.stringify({
        ...diagnostics,
        authoritativeSequence: authoritative?.sequence ?? null,
        authoritativeMarker: authoritative?.vt.includes(expected) ?? false,
        authoritativeEchoLines
      })}`
    );
  }
  return state.renderedAt - state.startedAt;
}

interface TerminalFrameMonitorState {
  done: boolean;
  completed: boolean;
  sawTerminal: boolean;
  blankFrames: number;
  firstTerminalAt: number | null;
  completedAt: number | null;
  totalMs: number;
  replacementMs: number;
}

async function startTerminalFrameMonitor(
  page: Page,
  surfaceId: string,
  finalMarker: string
): Promise<void> {
  await page.evaluate(
    ({ targetSurfaceId, marker }) => {
      type Monitor = TerminalFrameMonitorState & { startedAt: number };
      type MonitorWindow = Window & { __kmuxTerminalFrameMonitor?: Monitor };
      const monitorWindow = window as MonitorWindow;
      const state: Monitor = {
        startedAt: performance.now(),
        done: false,
        completed: false,
        sawTerminal: false,
        blankFrames: 0,
        firstTerminalAt: null,
        completedAt: null,
        totalMs: Number.POSITIVE_INFINITY,
        replacementMs: Number.POSITIVE_INFINITY
      };
      monitorWindow.__kmuxTerminalFrameMonitor = state;
      const frame = (): void => {
        if (monitorWindow.__kmuxTerminalFrameMonitor !== state) {
          return;
        }
        const element = [
          ...document.querySelectorAll<HTMLElement>("[data-testid]")
        ].find(
          (candidate) =>
            candidate.getAttribute("data-testid") ===
            `terminal-${targetSurfaceId}`
        );
        if (element) {
          const now = performance.now();
          state.sawTerminal = true;
          state.firstTerminalAt ??= now;
          const rows = element.querySelector(".xterm-rows")?.textContent ?? "";
          if (rows.trim().length === 0) {
            state.blankFrames += 1;
          }
          const lastOnRenderAt = Number(element.dataset.terminalLastOnRenderAt);
          if (
            rows.includes(marker) &&
            Number.isFinite(lastOnRenderAt) &&
            lastOnRenderAt >= state.startedAt
          ) {
            state.completed = true;
            state.completedAt = now;
            state.totalMs = now - state.startedAt;
            state.replacementMs = now - state.firstTerminalAt;
            state.done = true;
            return;
          }
        }
        if (performance.now() - state.startedAt >= 3_000) {
          state.done = true;
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    { targetSurfaceId: surfaceId, marker: finalMarker }
  );
}

async function waitForTerminalFrameMonitor(
  page: Page,
  timeout: number
): Promise<TerminalFrameMonitorState> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __kmuxTerminalFrameMonitor?: TerminalFrameMonitorState;
              }
            ).__kmuxTerminalFrameMonitor?.done ?? false
        ),
      { timeout }
    )
    .toBe(true);
  const state = await page.evaluate(
    () =>
      (
        window as Window & {
          __kmuxTerminalFrameMonitor?: TerminalFrameMonitorState;
        }
      ).__kmuxTerminalFrameMonitor
  );
  if (!state) {
    throw new Error("terminal frame monitor did not publish a result");
  }
  return state;
}

function extractTailTokens(text: string, label: string): string[] {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...text.matchAll(
      new RegExp(`\\[kmux-tail:${escapedLabel}:\\d{4}:value-\\d{5}\\]`, "g")
    )
  ].map((match) => match[0]);
}

function countOccurrences(text: string, expected: string): number {
  return expected ? text.split(expected).length - 1 : 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
    )
  ]!;
}

function assertSupervisorBounds(events: ProfileEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  let observedFourVisibleAttachments = false;
  for (const event of events) {
    const details = event.details;
    const sessionCount = Number(details.sessions ?? 0);
    const attachments = Number(details.attachments ?? 0);
    observedFourVisibleAttachments ||= attachments === MAX_LIVE_ATTACHMENTS;
    expect(attachments).toBeLessThanOrEqual(MAX_LIVE_ATTACHMENTS);
    expect(Number(details.ringBoundViolationCount ?? 0)).toBe(0);
    expect(Number(details.ringOversizedDeltaCount ?? 0)).toBe(0);
    expect(Number(details.creditBoundViolationCount ?? 0)).toBe(0);
    expect(Number(details.ringMaxSessionBytes)).toBe(RING_MAX_SESSION_BYTES);
    expect(Number(details.ringMaxSessionEvents)).toBe(RING_MAX_SESSION_EVENTS);
    expect(Number(details.ringMaxTotalBytes)).toBe(RING_MAX_TOTAL_BYTES);
    expect(Number(details.ringMaxTotalEvents)).toBe(RING_MAX_TOTAL_EVENTS);
    if (sessionCount > 0) {
      expect(Number(details.queueHighWatermarkBytes)).toBe(
        QUEUE_HIGH_WATERMARK_BYTES
      );
      expect(Number(details.queueLowWatermarkBytes)).toBe(
        QUEUE_LOW_WATERMARK_BYTES
      );
      expect(Number(details.outstandingOutputEventLimit)).toBe(
        RING_MAX_SESSION_EVENTS
      );
      expect(Number(details.outstandingOutputByteLimit)).toBe(
        ATTACH_MAX_OUTSTANDING_OUTPUT_BYTES
      );
    }
    expect(
      Number(details.peakSessionPendingOutputBytes ?? 0)
    ).toBeLessThanOrEqual(Number(details.queueHighWatermarkBytes ?? 0));
    expect(Number(details.ringPeakSessionBytes ?? 0)).toBeLessThanOrEqual(
      Number(details.ringMaxSessionBytes ?? 0)
    );
    expect(Number(details.ringPeakSessionEvents ?? 0)).toBeLessThanOrEqual(
      Number(details.ringMaxSessionEvents ?? 0)
    );
    expect(Number(details.ringPeakTotalBytes ?? 0)).toBeLessThanOrEqual(
      Number(details.ringMaxTotalBytes ?? 0)
    );
    expect(Number(details.ringPeakTotalEvents ?? 0)).toBeLessThanOrEqual(
      Number(details.ringMaxTotalEvents ?? 0)
    );
    expect(Number(details.peakAttachmentCreditBytes ?? 0)).toBeLessThanOrEqual(
      Number(details.creditLimitBytes ?? 0)
    );
    expect(Number(details.peakAttachmentCreditBytes ?? 0)).toBeLessThanOrEqual(
      ATTACH_INITIAL_CREDIT_BYTES
    );
    expect(
      Number(details.peakAttachmentOutstandingOutputBytes ?? 0)
    ).toBeLessThanOrEqual(Number(details.outstandingOutputByteLimit ?? 0));
    expect(
      Number(details.peakAttachmentOutstandingOutputEvents ?? 0)
    ).toBeLessThanOrEqual(Number(details.outstandingOutputEventLimit ?? 0));
  }
  expect(observedFourVisibleAttachments).toBe(true);
}

async function waitForRenderedSequence(
  page: Page,
  surfaceId: string,
  timeout = 1_000,
  expectedSequence?: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const value = await page
          .getByTestId(`terminal-${surfaceId}`)
          .getAttribute("data-terminal-rendered-sequence");
        if (value === null) {
          return null;
        }
        const sequence = Number(value);
        return expectedSequence === undefined || sequence >= expectedSequence
          ? sequence
          : null;
      },
      { timeout }
    )
    .not.toBeNull();
}
