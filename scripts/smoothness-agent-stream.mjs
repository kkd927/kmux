// Deterministic generator that mimics the terminal output of an interactive
// coding agent (Claude Code / Codex / Antigravity): an in-place "live region" that
// repaints every frame (spinner, progress bar, status), periodically committed
// prose / diff / code blocks that scroll the buffer, and occasional full-screen
// redraws. Used by the smoothness profiling e2e (and handy to eyeball manually)
// to drive a representative, repeatable render workload instead of plain
// `printf` lines — real agents emit cursor addressing, SGR colors, line clears
// and full-block repaints, which are far more expensive for the xterm renderer
// than newline-delimited text.
//
// Usage:
//   node scripts/smoothness-agent-stream.mjs --mode steady --frames 320 --interval 16
//   node scripts/smoothness-agent-stream.mjs --mode burst  --frames 800
//
// `steady` paces one repaint frame per `--interval` ms (exercises the live
// stream + scroll reflow over wall-clock, so the renderer write profiler — which
// flushes a bucket every ~1000ms — collects multiple samples). `burst` emits one
// large block at once (exercises a single heavy write / peak repaint, hitting
// the 64KB output-batcher cap).

import process from "node:process";
import { clearInterval, setInterval } from "node:timers";

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "steady";
const frames = Number(args.frames ?? (mode === "burst" ? 800 : 320));
const intervalMs = Number(args.interval ?? 16);
const cols = Number(args.cols ?? 64);
const rand = mulberry32(Number(args.seed ?? 1337));

const DONE = "__KMUX_STREAM_DONE__";
// Optional per-run suffix so a test can fire several runs into one session and
// wait for each one individually (e.g. repeated bursts for multiple samples).
const doneMarker = args.label ? `${DONE}:${args.label}` : DONE;
const ESC = "\x1b[";
const reset = `${ESC}0m`;
const bold = `${ESC}1m`;
const dim = `${ESC}2m`;
const underline = `${ESC}4m`;
const fg = (n) => `${ESC}38;5;${n}m`;
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS =
  "the function returns a promise that resolves once the worker finishes parsing the incoming chunk and updates the render buffer we should batch these writes to avoid layout thrash before flushing to the terminal".split(
    " "
  );
const FILES = [
  "src/app.ts",
  "src/render/terminal.tsx",
  "packages/core/index.ts",
  "scripts/build.mjs",
  "apps/desktop/main.ts"
];
const SNIPPETS = [
  "const next = batch(chunk);",
  "return queue.flush();",
  "if (!ready) return;",
  "this.cursor.move(row, col);",
  "await sink.write(data);",
  "const out = render(state);"
];

// `painted` tracks how many physical rows the live region currently occupies so
// the next frame can move the cursor back up and repaint in place. Periodic full
// clears re-sync this if line wrapping ever drifts the count.
let painted = 0;

function paintLive(lines) {
  let out = "";
  if (painted > 1) {
    out += `${ESC}${painted - 1}A`;
  }
  out += `\r${ESC}0J`;
  out += lines.join("\r\n");
  painted = lines.length;
  return out;
}

function clearLive() {
  let out = "";
  if (painted > 1) {
    out += `${ESC}${painted - 1}A`;
  }
  if (painted > 0) {
    out += `\r${ESC}0J`;
  }
  painted = 0;
  return out;
}

function commit(lines) {
  return lines.map((line) => `${line}\r\n`).join("");
}

function fullClear() {
  painted = 0;
  return `${ESC}2J${ESC}H`;
}

function liveLines(i) {
  const spin = fg(213) + SPIN[i % SPIN.length] + reset;
  const secs = ((i * intervalMs) / 1000).toFixed(1);
  const pct = Math.min(99, Math.floor(((i % 120) / 120) * 100));
  const filled = Math.floor(pct / 5);
  const bar =
    fg(42) + "█".repeat(filled) + dim + "░".repeat(20 - filled) + reset;
  const file = FILES[i % FILES.length];
  return [
    `${spin} ${bold}Working${reset}${dim}… (${secs}s)${reset}`,
    `  ${bar} ${fg(250)}${pct}%${reset}`,
    `  ${fg(39)}→${reset} editing ${underline}${file}${reset}`,
    `  ${dim}${SPIN[(i + 3) % SPIN.length]} running checks${reset}`
  ];
}

function proseLines(i) {
  const count = 2 + (i % 3);
  const lines = [];
  for (let n = 0; n < count; n += 1) {
    let line = "";
    const words = 6 + Math.floor(rand() * 5);
    for (let w = 0; w < words; w += 1) {
      const word = WORDS[Math.floor(rand() * WORDS.length)];
      const roll = rand();
      if (roll < 0.1) {
        line += `${bold}${fg(220)}${word}${reset} `;
      } else if (roll < 0.2) {
        line += `${fg(114)}\`${word}\`${reset} `;
      } else {
        line += `${fg(252)}${word}${reset} `;
      }
    }
    lines.push(`${fg(244)}│${reset} ${line.trimEnd()}`);
  }
  return lines;
}

function diffLines(i) {
  const file = FILES[i % FILES.length];
  const lines = [
    `${bold}${fg(39)}diff --git a/${file} b/${file}${reset}`,
    `${fg(244)}@@ -12,7 +12,9 @@${reset}`
  ];
  const count = 10 + (i % 8);
  for (let n = 0; n < count; n += 1) {
    const snippet = SNIPPETS[Math.floor(rand() * SNIPPETS.length)];
    const roll = rand();
    if (roll < 0.34) {
      lines.push(`${fg(42)}+ ${snippet}${reset}`);
    } else if (roll < 0.67) {
      lines.push(`${fg(203)}- ${snippet}${reset}`);
    } else {
      lines.push(`${fg(250)}  ${snippet}${reset}`);
    }
  }
  return lines;
}

function bannerLines() {
  const width = Math.min(cols - 2, 48);
  const label = " kmux agent session ".slice(0, width).padEnd(width);
  return [
    `${rgb(120, 170, 255)}┌${"─".repeat(width)}┐${reset}`,
    `${rgb(120, 170, 255)}│${reset}${bold}${label}${reset}${rgb(120, 170, 255)}│${reset}`,
    `${rgb(120, 170, 255)}└${"─".repeat(width)}┘${reset}`
  ];
}

function steadyFrame(i) {
  let out = "";
  if (i > 0 && i % 90 === 0) {
    out += fullClear();
    out += commit(bannerLines());
  }
  if (i > 0 && i % 30 === 0) {
    out += clearLive();
    out += commit(diffLines(i));
  } else if (i > 0 && i % 8 === 0) {
    out += clearLive();
    out += commit(proseLines(i));
  }
  out += paintLive(liveLines(i));
  return out;
}

function finishSteady(timer) {
  clearInterval(timer);
  process.stdout.write(`${clearLive()}${reset}\r\n${doneMarker}\r\n`, () => {
    process.exit(0);
  });
}

function runSteady() {
  let i = 0;
  process.stdout.write(`${fullClear()}${commit(bannerLines())}`);
  const timer = setInterval(
    () => {
      if (i >= frames) {
        finishSteady(timer);
        return;
      }
      process.stdout.write(steadyFrame(i));
      i += 1;
    },
    Math.max(0, intervalMs)
  );
}

function runBurst() {
  let out = fullClear() + commit(bannerLines());
  for (let i = 0; i < frames; i += 1) {
    out += i % 30 === 0 ? commit(diffLines(i)) : commit(proseLines(i));
  }
  out += `${reset}\r\n${doneMarker}\r\n`;
  process.stdout.write(out, () => {
    process.exit(0);
  });
}

if (mode === "burst") {
  runBurst();
} else {
  runSteady();
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        parsed[key] = "true";
      } else {
        parsed[key] = value;
        i += 1;
      }
    }
  }
  return parsed;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
