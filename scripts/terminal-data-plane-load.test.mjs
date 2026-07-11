import { spawn, spawnSync } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("./terminal-data-plane-load.mjs", import.meta.url)
);

describe("terminal data-plane load producer", () => {
  it("emits a deterministic alternate-screen trailer after a burst", () => {
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--burst-bytes",
        "16",
        "--label",
        "fixture",
        "--tail-lines",
        "3",
        "--mode",
        "tui"
      ],
      { encoding: "utf8", input: "", timeout: 5_000 }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\u001b[?1049h");
    expect(result.stdout).toContain("[kmux-tui-final:fixture]");
    expect(
      result.stdout.match(/\[kmux-tail:fixture:\d{4}:value-\d{5}\]/g)
    ).toEqual([
      "[kmux-tail:fixture:0000:value-00000]",
      "[kmux-tail:fixture:0001:value-07919]",
      "[kmux-tail:fixture:0002:value-15838]"
    ]);
    expect(result.stdout).toMatch(/\[kmux-burst-done:fixture:\d+\]\n$/);
  });

  it("primes a gated burst before a second interactive probe releases it", async () => {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "--burst-bytes",
        "16",
        "--label",
        "gated",
        "--burst-start-on-input",
        "1"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let sentWarmup = false;
    let sentRelease = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sentWarmup && stdout.includes("[kmux-burst-start:gated]")) {
        sentWarmup = true;
        child.stdin.write("b00\r");
      }
      if (!sentRelease && stdout.includes("[kmux-burst-active:gated]")) {
        sentRelease = true;
        child.stdin.end("b01\r");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("gated load producer timed out"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    const startAt = stdout.indexOf("[kmux-burst-start:gated]");
    const echoAt = stdout.indexOf("[kmux-echo:b00]");
    const activeAt = stdout.indexOf("[kmux-burst-active:gated]");
    const releaseAt = stdout.indexOf("[kmux-echo:b01]");
    const doneAt = stdout.indexOf("[kmux-burst-done:gated:");
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(echoAt).toBeGreaterThan(startAt);
    expect(activeAt).toBeGreaterThan(echoAt);
    expect(releaseAt).toBeGreaterThan(activeAt);
    expect(doneAt).toBeGreaterThan(releaseAt);
  });
});
