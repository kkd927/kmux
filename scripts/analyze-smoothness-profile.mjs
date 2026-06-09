import { readFileSync } from "node:fs";

const profilePath = process.argv[2];
if (!profilePath) {
  console.error(
    "Usage: node scripts/analyze-smoothness-profile.mjs <profile.jsonl>"
  );
  process.exit(1);
}

const events = readFileSync(profilePath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const byName = new Map();
for (const event of events) {
  const entries = byName.get(event.name) ?? [];
  entries.push(event);
  byName.set(event.name, entries);
}

function maxDetail(name, key) {
  return Math.max(
    0,
    ...(byName.get(name) ?? []).map((event) =>
      Number(event.details?.[key] ?? 0)
    )
  );
}

function sumDetail(name, key) {
  return (byName.get(name) ?? []).reduce(
    (sum, event) => sum + Number(event.details?.[key] ?? 0),
    0
  );
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function detailValues(name, key) {
  return (byName.get(name) ?? [])
    .map((event) => Number(event.details?.[key] ?? 0))
    .filter((value) => Number.isFinite(value));
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Sample count + percentiles per metric so a single noisy max does not stand in
// for the whole run (the renderer write bucket only flushes every ~1s, so short
// scenarios used to yield one unreliable sample).
function distribution(name, key) {
  const values = detailValues(name, key);
  return {
    samples: values.length,
    p50: round2(percentile(values, 50)),
    p95: round2(percentile(values, 95)),
    max: round2(Math.max(0, ...values))
  };
}

function topTerminalSurfaces(limit = 8) {
  const surfaces = new Map();
  for (const name of [
    "terminal.write.bucket",
    "terminal.ipc.bucket",
    "terminal.pty.bucket",
    "terminal.fit",
    "terminal.resize.request",
    "terminal.resize.ack",
    "terminal.resize.apply",
    "terminal.reflow"
  ]) {
    for (const event of byName.get(name) ?? []) {
      const surfaceId = event.details?.surfaceId;
      if (!surfaceId) {
        continue;
      }
      const entry =
        surfaces.get(surfaceId) ??
        {
          surfaceId,
          sessionIds: new Set(),
          writeBuckets: 0,
          ipcBuckets: 0,
          ptyBuckets: 0,
          writes: 0,
          chunks: 0,
          bytes: 0,
          maxWriteDurationMs: 0,
          maxWriteQueueDepth: 0,
          maxIpcSendDurationMs: 0,
          maxPtyChunkBytes: 0,
          fitEvents: 0,
          resizeRequests: 0,
          resizeAcks: 0,
          resizeApplies: 0,
          reflows: 0,
          maxFitDurationMs: 0,
          maxResizeAckDurationMs: 0,
          maxResizeApplyDurationMs: 0,
          maxReflowDurationMs: 0
        };
      const sessionId = event.details?.sessionId;
      if (sessionId) {
        entry.sessionIds.add(sessionId);
      }
      if (name === "terminal.write.bucket") {
        entry.writeBuckets += 1;
        entry.writes += Number(event.details?.writes ?? 0);
        entry.bytes += Number(event.details?.bytes ?? 0);
        entry.maxWriteDurationMs = Math.max(
          entry.maxWriteDurationMs,
          Number(event.details?.maxDurationMs ?? 0)
        );
        entry.maxWriteQueueDepth = Math.max(
          entry.maxWriteQueueDepth,
          Number(event.details?.maxQueueDepth ?? 0)
        );
      } else if (name === "terminal.ipc.bucket") {
        entry.ipcBuckets += 1;
        entry.chunks += Number(event.details?.chunks ?? 0);
        entry.bytes += Number(event.details?.bytes ?? 0);
        entry.maxIpcSendDurationMs = Math.max(
          entry.maxIpcSendDurationMs,
          Number(event.details?.maxSendDurationMs ?? 0)
        );
      } else if (name === "terminal.pty.bucket") {
        entry.ptyBuckets += 1;
        entry.chunks += Number(event.details?.chunks ?? 0);
        entry.bytes += Number(event.details?.bytes ?? 0);
        entry.maxPtyChunkBytes = Math.max(
          entry.maxPtyChunkBytes,
          Number(event.details?.maxChunkBytes ?? 0)
        );
      }
      if (name === "terminal.fit") {
        entry.fitEvents += 1;
        entry.maxFitDurationMs = Math.max(
          entry.maxFitDurationMs,
          Number(event.details?.durationMs ?? 0)
        );
      } else if (name === "terminal.resize.request") {
        entry.resizeRequests += 1;
      } else if (name === "terminal.resize.ack") {
        entry.resizeAcks += 1;
        entry.maxResizeAckDurationMs = Math.max(
          entry.maxResizeAckDurationMs,
          Number(event.details?.durationMs ?? 0)
        );
      } else if (name === "terminal.resize.apply") {
        entry.resizeApplies += 1;
        entry.maxResizeApplyDurationMs = Math.max(
          entry.maxResizeApplyDurationMs,
          Number(event.details?.durationMs ?? 0)
        );
      } else if (name === "terminal.reflow") {
        entry.reflows += 1;
        entry.maxReflowDurationMs = Math.max(
          entry.maxReflowDurationMs,
          Number(event.details?.durationMs ?? 0)
        );
      }
      surfaces.set(surfaceId, entry);
    }
  }

  return [...surfaces.values()]
    .map((entry) => ({
      ...entry,
      sessionIds: [...entry.sessionIds]
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);
}

const shellPatchCount = byName.get("shell.patch.emit")?.length ?? 0;
const terminalPaneRenderCount =
  byName.get("terminal-pane.render")?.length ?? 0;
const paneTreeRenderCount = byName.get("pane-tree.render")?.length ?? 0;

const summary = {
  eventCount: events.length,
  counts: Object.fromEntries(
    [...byName.entries()].map(([name, entries]) => [name, entries.length])
  ),
  maxTerminalWriteDurationMs: maxDetail(
    "terminal.write.bucket",
    "maxDurationMs"
  ),
  maxTerminalWriteQueueDepth: maxDetail(
    "terminal.write.bucket",
    "maxQueueDepth"
  ),
  maxTerminalIpcSendDurationMs: maxDetail(
    "terminal.ipc.bucket",
    "maxSendDurationMs"
  ),
  maxPtyChunkBytes: maxDetail("terminal.pty.bucket", "maxChunkBytes"),
  maxTerminalFitDurationMs: maxDetail("terminal.fit", "durationMs"),
  maxTerminalResizeAckDurationMs: maxDetail(
    "terminal.resize.ack",
    "durationMs"
  ),
  maxTerminalResizeApplyDurationMs: maxDetail(
    "terminal.resize.apply",
    "durationMs"
  ),
  maxTerminalReflowDurationMs: maxDetail("terminal.reflow", "durationMs"),
  maxShellPatchDurationMs: maxDetail("shell.patch.emit", "durationMs"),
  maxSelectorNotifyDurationMs: maxDetail(
    "shell.selector.notify",
    "durationMs"
  ),
  terminalPaneRenderCount,
  paneTreeRenderCount,
  paneTreeMemoSkipCount: byName.get("pane-tree.memo-skip")?.length ?? 0,
  shellPatchPayloadBytes: sumDetail("shell.patch.emit", "payloadBytes"),
  terminalPaneRenderPerPatch: ratio(terminalPaneRenderCount, shellPatchCount),
  paneTreeRenderPerPatch: ratio(paneTreeRenderCount, shellPatchCount),
  distributions: {
    terminalWriteDurationMs: distribution("terminal.write.bucket", "maxDurationMs"),
    terminalWriteQueueDepth: distribution("terminal.write.bucket", "maxQueueDepth"),
    terminalIpcSendDurationMs: distribution("terminal.ipc.bucket", "maxSendDurationMs"),
    ptyChunkBytes: distribution("terminal.pty.bucket", "maxChunkBytes"),
    terminalReflowDurationMs: distribution("terminal.reflow", "durationMs"),
    terminalResizeAckDurationMs: distribution("terminal.resize.ack", "durationMs"),
    terminalResizeApplyDurationMs: distribution("terminal.resize.apply", "durationMs"),
    terminalFitDurationMs: distribution("terminal.fit", "durationMs")
  },
  topTerminalSurfaces: topTerminalSurfaces()
};

const likelyBottlenecks = [];
if (summary.terminalPaneRenderCount > 20 || summary.paneTreeRenderCount > 20) {
  likelyBottlenecks.push("react-rerender");
}
if (
  summary.maxTerminalWriteDurationMs > 24 ||
  summary.maxTerminalWriteQueueDepth > 8 ||
  summary.maxTerminalIpcSendDurationMs > 8
) {
  likelyBottlenecks.push("terminal-output");
}
if (
  summary.maxTerminalFitDurationMs > 8 ||
  summary.maxTerminalResizeAckDurationMs > 50 ||
  summary.maxTerminalResizeApplyDurationMs > 16 ||
  summary.maxTerminalReflowDurationMs > 32
) {
  likelyBottlenecks.push("terminal-resize");
}
if (
  summary.maxShellPatchDurationMs > 12 ||
  summary.maxSelectorNotifyDurationMs > 8 ||
  summary.shellPatchPayloadBytes > 1_000_000
) {
  likelyBottlenecks.push("patch-frequency");
}

console.log(
  JSON.stringify(
    {
      ...summary,
      likelyBottlenecks
    },
    null,
    2
  )
);
