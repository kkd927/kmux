import type {
  SurfaceSnapshotPipelineProgress,
  SurfaceSnapshotRawOutputChunk,
  SurfaceSnapshotRawOutputTimeline,
  TerminalInputDiagnosticKind,
  TerminalOutputDiagnosticKind,
  Uint64
} from "@kmux/proto";
import { incrementUint64, uint64 } from "@kmux/proto";

export const RAW_OUTPUT_TAIL_MAX_CHARS = 128 * 1024;
export const RAW_OUTPUT_TIMELINE_MAX_CHUNKS = 2_048;

interface RawOutputObservation {
  ptyReadAt: number;
  outputKind: TerminalOutputDiagnosticKind;
  visibleAtPtyRead: boolean;
  inputSequence?: Uint64;
  inputKind?: TerminalInputDiagnosticKind;
}

export interface RawOutputTimelineSnapshot {
  rawOutputTail: string;
  rawOutputTailTruncated: boolean;
  timeline: SurfaceSnapshotRawOutputTimeline;
  progress: Pick<
    SurfaceSnapshotPipelineProgress,
    | "ptyRecordingWindow"
    | "lastAnyPtyReadAt"
    | "lastAnyPtyChunkSequence"
    | "lastScreenPtyReadAt"
    | "lastScreenPtyChunkSequence"
    | "lastTitleOnlyPtyReadAt"
    | "lastTitleOnlyPtyChunkSequence"
    | "lastIndeterminatePtyReadAt"
    | "lastIndeterminatePtyChunkSequence"
  >;
}

export interface RawOutputTimeline {
  append(chunk: string): void;
  record(chunk: string, observation: RawOutputObservation): void;
  snapshot(enabled: boolean): RawOutputTimelineSnapshot;
}

/**
 * Retains the raw-output tail continuously, but records per-read metadata only
 * while terminal telemetry is enabled. Timeline offsets are relative to the
 * current uninterrupted recording window; a negative raw-tail start means the
 * retained tail also contains output from before that window.
 */
export function createRawOutputTimeline(options?: {
  maxChunks?: number;
  maxTailChars?: number;
}): RawOutputTimeline {
  const maxChunks = Math.max(
    1,
    Math.floor(options?.maxChunks ?? RAW_OUTPUT_TIMELINE_MAX_CHUNKS)
  );
  const maxTailChars = Math.max(
    1,
    Math.floor(options?.maxTailChars ?? RAW_OUTPUT_TAIL_MAX_CHARS)
  );
  const chunks: Array<SurfaceSnapshotRawOutputChunk | undefined> = new Array(
    maxChunks
  );
  let chunkSequence = uint64(0n);
  let totalBytes = 0;
  let totalChars = 0;
  let retainedStart = 0;
  let retainedCount = 0;
  let droppedChunks = 0;
  let rawOutputTail = "";
  let rawOutputTailTruncated = false;
  let recordingActive = false;
  let recordingWindow = 0;
  let lastAny: SurfaceSnapshotRawOutputChunk | null = null;
  let lastScreen: SurfaceSnapshotRawOutputChunk | null = null;
  let lastTitleOnly: SurfaceSnapshotRawOutputChunk | null = null;
  let lastIndeterminate: SurfaceSnapshotRawOutputChunk | null = null;

  const push = (entry: SurfaceSnapshotRawOutputChunk): void => {
    if (retainedCount < maxChunks) {
      chunks[(retainedStart + retainedCount) % maxChunks] = entry;
      retainedCount += 1;
      return;
    }
    chunks[retainedStart] = entry;
    retainedStart = (retainedStart + 1) % maxChunks;
    droppedChunks += 1;
  };

  const appendTail = (chunk: string): void => {
    rawOutputTail += chunk;
    if (rawOutputTail.length > maxTailChars) {
      rawOutputTail = rawOutputTail.slice(-maxTailChars);
      rawOutputTailTruncated = true;
    }
  };

  const resetRecording = (): void => {
    chunks.fill(undefined);
    chunkSequence = uint64(0n);
    totalBytes = 0;
    totalChars = 0;
    retainedStart = 0;
    retainedCount = 0;
    droppedChunks = 0;
    lastAny = null;
    lastScreen = null;
    lastTitleOnly = null;
    lastIndeterminate = null;
  };

  return {
    append(chunk): void {
      if (!chunk) {
        return;
      }
      if (recordingActive) {
        recordingActive = false;
        resetRecording();
      }
      appendTail(chunk);
    },
    record(chunk, observation): void {
      if (!chunk) {
        return;
      }
      if (!recordingActive) {
        resetRecording();
        recordingActive = true;
        recordingWindow += 1;
      }
      const byteStart = totalBytes;
      const charStart = totalChars;
      const utf8Bytes = Buffer.byteLength(chunk, "utf8");
      chunkSequence = incrementUint64(chunkSequence);
      totalBytes += utf8Bytes;
      totalChars += chunk.length;
      appendTail(chunk);
      const entry: SurfaceSnapshotRawOutputChunk = {
        chunkSequence,
        ptyReadAt: observation.ptyReadAt,
        byteStart,
        byteEnd: totalBytes,
        charStart,
        charEnd: totalChars,
        utf8Bytes,
        chars: chunk.length,
        outputKind: observation.outputKind,
        visibleAtPtyRead: observation.visibleAtPtyRead,
        ...(observation.inputSequence === undefined
          ? {}
          : { inputSequence: observation.inputSequence }),
        ...(observation.inputKind === undefined
          ? {}
          : { inputKind: observation.inputKind })
      };
      push(entry);
      lastAny = entry;
      if (entry.outputKind === "screen" || entry.outputKind === "mixed") {
        lastScreen = entry;
      }
      if (entry.outputKind === "osc-title-only") {
        lastTitleOnly = entry;
      }
      if (entry.outputKind === "indeterminate") {
        lastIndeterminate = entry;
      }
    },

    snapshot(enabled): RawOutputTimelineSnapshot {
      const retained = Array.from(
        { length: retainedCount },
        (_, index) => chunks[(retainedStart + index) % maxChunks]
      ).filter(
        (entry): entry is SurfaceSnapshotRawOutputChunk => entry !== undefined
      );
      return {
        rawOutputTail,
        rawOutputTailTruncated,
        timeline: {
          enabled,
          offsetOrigin: "recording-window",
          recordingWindow,
          sampleEvery: 1,
          maxChunks,
          totalChunks: chunkSequence,
          retainedChunks: retained.length,
          droppedChunks,
          unobservedChunks: 0,
          rawTailCharStart: totalChars - rawOutputTail.length,
          rawTailCharEnd: totalChars,
          chunks: retained
        },
        progress: {
          ptyRecordingWindow: recordingWindow,
          lastAnyPtyReadAt: lastAny?.ptyReadAt ?? null,
          lastAnyPtyChunkSequence: lastAny?.chunkSequence ?? null,
          lastScreenPtyReadAt: lastScreen?.ptyReadAt ?? null,
          lastScreenPtyChunkSequence: lastScreen?.chunkSequence ?? null,
          lastTitleOnlyPtyReadAt: lastTitleOnly?.ptyReadAt ?? null,
          lastTitleOnlyPtyChunkSequence: lastTitleOnly?.chunkSequence ?? null,
          lastIndeterminatePtyReadAt: lastIndeterminate?.ptyReadAt ?? null,
          lastIndeterminatePtyChunkSequence:
            lastIndeterminate?.chunkSequence ?? null
        }
      };
    }
  };
}
