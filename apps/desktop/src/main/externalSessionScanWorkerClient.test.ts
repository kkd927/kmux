import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatAgentCommandForShell } from "@kmux/core";

import {
  createExternalSessionScanWorkerClient,
  resolveExternalSessionScanWorkerLaunchOptions
} from "./externalSessionScanWorkerClient";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { force: true, recursive: true });
  }
});

describe("external session scan worker client", () => {
  it("resolves packaged, production, and development worker entries", () => {
    expect(
      resolveExternalSessionScanWorkerLaunchOptions(
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
        "production",
        "/Applications/kmux.app/Contents/Resources"
      )
    ).toEqual({
      entry:
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main/externalSessionScanWorker.js",
      cwd: "/Applications/kmux.app/Contents/Resources/app.asar.unpacked",
      execArgv: []
    });
    expect(
      resolveExternalSessionScanWorkerLaunchOptions(
        "/Users/test/kmux/apps/desktop/out/main",
        "production"
      )
    ).toEqual({
      entry:
        "/Users/test/kmux/apps/desktop/out/main/externalSessionScanWorker.js",
      cwd: "/Users/test/kmux",
      execArgv: []
    });
    expect(
      resolveExternalSessionScanWorkerLaunchOptions(
        "/Users/test/kmux/apps/desktop/src/main",
        "development"
      )
    ).toEqual({
      entry:
        "/Users/test/kmux/apps/desktop/src/main/externalSessionScanWorker.ts",
      cwd: "/Users/test/kmux",
      execArgv: ["--import", "tsx"]
    });
  });

  it("scans and resolves sessions outside the parent process", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "kmux-session-worker-"));
    cleanupPaths.push(homeDir);
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "07", "28");
    const timestamp = new Date().toISOString();
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "rollout-worker-session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: { id: "worker-session", cwd: "/tmp/worker-project" }
        }),
        ""
      ].join("\n"),
      "utf8"
    );
    const client = createExternalSessionScanWorkerClient({
      homeDir,
      env: { PATH: process.env.PATH },
      settings: {
        agents: {
          local: {
            codex: { command: process.execPath }
          }
        }
      }
    });

    try {
      const snapshot = await client.listExternalAgentSessions();
      expect(snapshot.sessions).toEqual([
        expect.objectContaining({
          key: "codex:worker-session",
          canResume: true
        })
      ]);
      expect(
        client.resolveExternalAgentSession("codex:worker-session")
      ).toMatchObject({
        launch: {
          initialInput: `${formatAgentCommandForShell([
            process.execPath,
            "resume",
            "worker-session"
          ])}\r`
        }
      });
    } finally {
      client.close?.();
    }
  });
});
