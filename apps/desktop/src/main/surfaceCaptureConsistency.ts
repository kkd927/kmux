import type { SurfaceCaptureContentConsistency } from "@kmux/proto";

// Cross-checks the pty snapshot against the renderer's recent buffer content
// without relying on rendered-sequence diagnostics, which can freeze when
// their updates stop reaching the DOM. Sampling targets recent *scrollback*
// (the lines just above the snapshot's live screen): the live TUI region is
// repainted in place and legitimately differs between the two capture
// moments, while scrollback is append-only and stable.
//
// Lines are compared with all whitespace removed: coding-agent TUIs position
// words with cursor jumps (never-written null cells) and pad rows to the
// grid width, so spacing differs across layers and wrap widths while the
// character content does not. Reflowed wraps also stop mattering because a
// sampled row's characters stay contiguous in the joined renderer text.

const SAMPLE_MAX_LINES = 8;
const SAMPLE_MIN_LINES = 3;
const SAMPLE_MIN_CHARS = 8;
const ESC_SEQUENCE = String.raw`\u001b`;
const BEL_SEQUENCE = String.raw`\u0007`;
const ANSI_OSC_RE = new RegExp(
  `${ESC_SEQUENCE}\\][^${BEL_SEQUENCE}${ESC_SEQUENCE}]*(?:${BEL_SEQUENCE}|${ESC_SEQUENCE}\\\\)`,
  "g"
);
const ANSI_CSI_RE = new RegExp(`${ESC_SEQUENCE}\\[[0-9;?]*[A-Za-z@]`, "g");
const ANSI_CHARSET_RE = new RegExp(
  `${ESC_SEQUENCE}[=>()#][0-9A-Za-z]?`,
  "g"
);

export function assessContentConsistency({
  snapshotVt,
  snapshotScreenRows,
  rendererRecentText
}: {
  snapshotVt: string | null | undefined;
  snapshotScreenRows: number | null | undefined;
  rendererRecentText: string | null | undefined;
}): SurfaceCaptureContentConsistency {
  if (!snapshotVt || !rendererRecentText) {
    return { verdict: "indeterminate", sampledLines: 0, matchedLines: 0 };
  }

  const plainLines = stripAnsi(snapshotVt).split("\n");
  const screenRows = Math.max(0, snapshotScreenRows ?? 0);
  const stableLines = plainLines.slice(
    0,
    Math.max(0, plainLines.length - screenRows)
  );

  const samples: string[] = [];
  for (
    let index = stableLines.length - 1;
    index >= 0 && samples.length < SAMPLE_MAX_LINES;
    index -= 1
  ) {
    const normalized = normalizeContent(stableLines[index]);
    if (normalized.length >= SAMPLE_MIN_CHARS) {
      samples.push(normalized);
    }
  }
  if (samples.length < SAMPLE_MIN_LINES) {
    return {
      verdict: "indeterminate",
      sampledLines: samples.length,
      matchedLines: 0
    };
  }

  const haystack = normalizeContent(rendererRecentText);
  const matchedLines = samples.filter((sample) =>
    haystack.includes(sample)
  ).length;
  return {
    verdict: matchedLines * 2 >= samples.length ? "consistent" : "behind",
    sampledLines: samples.length,
    matchedLines
  };
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, "");
}

function stripAnsi(value: string): string {
  return value
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_CHARSET_RE, "")
    .replace(/\r/g, "");
}
