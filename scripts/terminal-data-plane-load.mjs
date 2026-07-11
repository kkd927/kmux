// Deterministic PTY producer used by the opt-in 16-session v2 performance gate.
// It writes fixed-size frames and leaves stdin flowing so key echo can be
// probed while output is pending.
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  clearInterval,
  setImmediate,
  setInterval,
  setTimeout
} from "node:timers";

const args = parseArgs(process.argv.slice(2));
const durationMs = positiveNumber(args.duration, 30_000);
const intervalMs = positiveNumber(args.interval, 50);
const frameBytes = positiveNumber(args.bytes, 1024);
const burstBytes = optionalPositiveNumber(args["burst-bytes"]);
const startDelayMs = nonNegativeNumber(args["start-delay"], 0);
const burstChunkDelayMs = nonNegativeNumber(args["burst-chunk-delay"], 0);
const burstStartOnInput = args["burst-start-on-input"] !== undefined;
const echoPauseMs = nonNegativeNumber(
  args["echo-pause"],
  burstBytes === undefined ? 250 : 20
);
const tailLines = nonNegativeInteger(args["tail-lines"], 0);
const mode = args.mode === "tui" ? "tui" : "plain";
const label = args.label ?? "session";
const prefix = `[kmux-load:${label}] `;
const ANSI_CSI_PATTERN = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`,
  "g"
);
const body = "x".repeat(Math.max(1, frameBytes - prefix.length - 2));
// Write Unix newlines and let the PTY's ONLCR processing produce CRLF on the
// wire, as real CLI programs do. Writing CRLF here would become CRCRLF and
// exercise the conservative bare-CR redraw path instead of plain appends.
const frame = `${prefix}${body}\n`;
let startedAt = 0;
let outputPausedUntil = Number.NEGATIVE_INFINITY;
let remainingBurstBytes = burstBytes ?? 0;
let burstCompleted = false;
let burstStarted = false;
let burstGatePhase = "inactive";
let stdinBuffer = "";

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (data) => {
  stdinBuffer += data.toString("utf8");
  for (;;) {
    const lineEnd = stdinBuffer.search(/[\r\n]/);
    if (lineEnd < 0) {
      if (stdinBuffer.length > 4_096) {
        stdinBuffer = stdinBuffer.slice(-4_096);
      }
      return;
    }
    const line = stdinBuffer.slice(0, lineEnd);
    stdinBuffer = stdinBuffer.slice(lineEnd + 1).replace(/^[\r\n]+/, "");
    echoProbe(line);
  }
});

function echoProbe(line) {
  const probe = line
    .replace(ANSI_CSI_PATTERN, "")
    .split("")
    .filter((character) => {
      const codeUnit = character.charCodeAt(0);
      return codeUnit > 0x1f && codeUnit !== 0x7f;
    })
    .join("")
    .slice(0, 256);
  if (!probe) {
    return;
  }
  // Keep the structured echo on screen long enough for the paint probe to
  // observe it. The other 15 sessions continue producing at full rate.
  outputPausedUntil = Date.now() + echoPauseMs;
  const burstState =
    burstBytes === undefined ? "stream" : burstCompleted ? "done" : "pending";
  const probeToken = Buffer.from(probe, "utf8").toString("base64url");
  const gateAction =
    burstGatePhase === "warmup"
      ? "prime"
      : burstGatePhase === "release"
        ? "release"
        : null;
  if (gateAction === "prime") {
    burstGatePhase = "priming";
  } else if (gateAction === "release") {
    burstGatePhase = "running";
  }
  process.stdout.write(
    `\x1b]515;${probeToken}\x07\n[kmux-echo:${probe}]\n` +
      `[kmux-echo-state:${label}:${probe}:${burstState}:${remainingBurstBytes}]\n`,
    () => {
      if (gateAction === "prime") {
        primeGatedBurst();
      } else if (gateAction === "release") {
        beginBurst();
      }
    }
  );
}

process.stdout.write(`[kmux-load-ready:${label}]\n`);
if (startDelayMs > 0) {
  setTimeout(startWorkload, startDelayMs);
} else {
  startWorkload();
}

function startWorkload() {
  startedAt = Date.now();
  if (mode === "tui") {
    process.stdout.write(
      `\x1b[?1049h\x1b[2J\x1b[H[kmux-tui-loading:${label}]\n`
    );
  }
  if (burstBytes === undefined) {
    startSteadyLoad();
  } else {
    if (burstStartOnInput) {
      burstGatePhase = "warmup";
    }
    process.stdout.write(`[kmux-burst-start:${label}]\n`, () => {
      if (!burstStartOnInput) {
        beginBurst();
      }
    });
  }
}

function primeGatedBurst() {
  if (burstBytes === undefined || burstGatePhase !== "priming") {
    return;
  }
  const chunkBytes = Math.min(64 * 1024, remainingBurstBytes);
  remainingBurstBytes -= chunkBytes;
  process.stdout.write("x".repeat(chunkBytes), () => {
    process.stdout.write(`[kmux-burst-active:${label}]\n`, () => {
      burstGatePhase = "release";
    });
  });
}

function beginBurst() {
  if (burstStarted || burstBytes === undefined) {
    return;
  }
  burstStarted = true;
  writeBurst(remainingBurstBytes);
}

function startSteadyLoad() {
  const timer = setInterval(() => {
    if (Date.now() - startedAt >= durationMs) {
      clearInterval(timer);
      process.stdout.write(`[kmux-load-done:${label}]\n`, () => {
        process.exit(0);
      });
      return;
    }
    if (Date.now() >= outputPausedUntil) {
      process.stdout.write(frame);
    }
  }, intervalMs);
}

function writeBurst(totalBytes) {
  const maxChunkBytes = 64 * 1024;
  remainingBurstBytes = totalBytes;

  const pump = () => {
    const pauseForMs = outputPausedUntil - Date.now();
    if (pauseForMs > 0) {
      setTimeout(pump, pauseForMs);
      return;
    }
    if (remainingBurstBytes === 0) {
      writeBurstTrailer();
      return;
    }
    const chunkBytes = Math.min(maxChunkBytes, remainingBurstBytes);
    remainingBurstBytes -= chunkBytes;
    const canContinue = process.stdout.write("x".repeat(chunkBytes));
    if (canContinue) {
      scheduleBurstPump(pump);
    } else {
      process.stdout.once("drain", () => scheduleBurstPump(pump));
    }
  };

  setImmediate(pump);
}

function scheduleBurstPump(pump) {
  if (burstChunkDelayMs > 0) {
    setTimeout(pump, burstChunkDelayMs);
  } else {
    setImmediate(pump);
  }
}

function writeBurstTrailer() {
  burstCompleted = true;
  const finishedAt = Date.now();
  const tail = Array.from(
    { length: tailLines },
    (_, index) =>
      `[kmux-tail:${label}:${String(index).padStart(4, "0")}:` +
      `value-${String((index * 7919) % 100_000).padStart(5, "0")}]`
  );
  const lines =
    mode === "tui"
      ? [
          `\x1b[2J\x1b[H[kmux-tui-final:${label}]`,
          `[kmux-tui-stable:${label}:alpha]`,
          `[kmux-tui-stable:${label}:beta]`,
          ...tail,
          `[kmux-burst-done:${label}:${finishedAt}]`
        ]
      : [...tail, `[kmux-burst-done:${label}:${finishedAt}]`];
  process.stdout.write(`${lines.join("\n")}\n`, () => {
    process.exit(0);
  });
}

function optionalPositiveNumber(value) {
  if (value === undefined) {
    return;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Math.floor(nonNegativeNumber(value, fallback));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      parsed[token.slice(2)] = value;
      index += 1;
    }
  }
  return parsed;
}
