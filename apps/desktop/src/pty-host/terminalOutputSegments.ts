const OSC7_PREFIX = "\x1b]7;";
const BEL = "\x07";
const STRING_TERMINATOR = "\x1b\\";

export interface TerminalOutputSegmenterState {
  pendingOsc7: boolean;
  pendingOsc7Prefix?: string;
}

export interface TerminalOutputSegment {
  chunk: string;
  recordCwd: boolean;
}

export function splitTerminalOutputByOsc7({
  chunk,
  state = { pendingOsc7: false }
}: {
  chunk: string;
  state?: TerminalOutputSegmenterState;
}): {
  segments: TerminalOutputSegment[];
  state: TerminalOutputSegmenterState;
} {
  const segments: TerminalOutputSegment[] = [];
  const input = `${state.pendingOsc7Prefix ?? ""}${chunk}`;
  let index = 0;
  let pendingOsc7 = state.pendingOsc7;
  let pendingOsc7Prefix = "";

  while (index < input.length) {
    if (pendingOsc7) {
      const terminator = findOscTerminator(input, index);
      if (!terminator) {
        pushSegment(segments, input.slice(index), false);
        index = input.length;
        continue;
      }
      pushSegment(segments, input.slice(index, terminator.endIndex), false);
      pendingOsc7 = false;
      index = terminator.endIndex;
      continue;
    }

    const osc7Start = input.indexOf(OSC7_PREFIX, index);
    if (osc7Start === -1) {
      const trailingPrefixLength = getTrailingPrefixLength(input.slice(index));
      if (trailingPrefixLength > 0) {
        pushSegment(segments, input.slice(index, -trailingPrefixLength), true);
        pendingOsc7Prefix = input.slice(-trailingPrefixLength);
      } else {
        pushSegment(segments, input.slice(index), true);
      }
      index = input.length;
      continue;
    }

    pushSegment(segments, input.slice(index, osc7Start), true);
    const terminator = findOscTerminator(input, osc7Start + OSC7_PREFIX.length);
    if (!terminator) {
      pushSegment(segments, input.slice(osc7Start), false);
      pendingOsc7 = true;
      index = input.length;
      continue;
    }

    pushSegment(segments, input.slice(osc7Start, terminator.endIndex), false);
    index = terminator.endIndex;
  }

  return {
    segments,
    state: { pendingOsc7, pendingOsc7Prefix }
  };
}

export function flushTerminalOutputSegmenterState(
  state: TerminalOutputSegmenterState
): {
  segments: TerminalOutputSegment[];
  state: TerminalOutputSegmenterState;
} {
  return {
    segments: state.pendingOsc7Prefix
      ? [{ chunk: state.pendingOsc7Prefix, recordCwd: true }]
      : [],
    state: { pendingOsc7: state.pendingOsc7, pendingOsc7Prefix: "" }
  };
}

function pushSegment(
  segments: TerminalOutputSegment[],
  chunk: string,
  recordCwd: boolean
): void {
  if (chunk) {
    segments.push({ chunk, recordCwd });
  }
}

function findOscTerminator(
  text: string,
  startIndex: number
): { endIndex: number } | null {
  const belIndex = text.indexOf(BEL, startIndex);
  const stIndex = text.indexOf(STRING_TERMINATOR, startIndex);
  if (belIndex === -1 && stIndex === -1) {
    return null;
  }
  if (belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)) {
    return { endIndex: belIndex + BEL.length };
  }
  return { endIndex: stIndex + STRING_TERMINATOR.length };
}

function getTrailingPrefixLength(text: string): number {
  const maxLength = Math.min(text.length, OSC7_PREFIX.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (OSC7_PREFIX.startsWith(text.slice(-length))) {
      return length;
    }
  }
  return 0;
}
