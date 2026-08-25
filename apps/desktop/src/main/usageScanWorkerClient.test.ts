import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatAgentCommandForShell } from "@kmux/core";

import {
  createUsageScanWorkerClient,
  resolveUsageScanWorkerLaunchOptions
} from "./usageScanWorkerClient";
import type {
  UsageScanWorkerRequest,
  UsageScanWorkerResponse
} from "./usageScanProtocol";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { force: true, recursive: true });
  }
});

describe("usage scan worker launch", () => {
  it("resolves the bundled worker inside app.asar with an unpacked cwd", () => {
    expect(
      resolveUsageScanWorkerLaunchOptions(
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main",
        "production",
        "/Applications/kmux.app/Contents/Resources"
      )
    ).toEqual({
      entry:
        "/Applications/kmux.app/Contents/Resources/app.asar/out/main/usageScanWorker.js",
      cwd: "/Applications/kmux.app/Contents/Resources/app.asar.unpacked",
      execArgv: []
    });
  });

  it("resolves the built worker for a production repository launch", () => {
    expect(
      resolveUsageScanWorkerLaunchOptions(
        "/Users/test/kmux/apps/desktop/out/main",
        "production"
      )
    ).toEqual({
      entry: "/Users/test/kmux/apps/desktop/out/main/usageScanWorker.js",
      cwd: "/Users/test/kmux",
      execArgv: []
    });
  });

  it("runs the TypeScript worker through tsx during development", () => {
    expect(
      resolveUsageScanWorkerLaunchOptions(
        "/Users/test/kmux/apps/desktop/src/main",
        "development"
      )
    ).toEqual({
      entry: "/Users/test/kmux/apps/desktop/src/main/usageScanWorker.ts",
      cwd: "/Users/test/kmux",
      execArgv: ["--import", "tsx"]
    });
  });

  it("shares one worker and source inventory across usage and external-session projections", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "kmux-metadata-worker-"));
    cleanupPaths.push(homeDir);
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "08", "17");
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
    const client = createUsageScanWorkerClient({
      homeDir,
      env: { PATH: process.env.PATH },
      agentSettings: {
        codex: { command: process.execPath }
      }
    });

    try {
      const usage = await client.scan({ startOfDayMs: 0, initial: true });
      const snapshot =
        await client.externalSessions.listExternalAgentSessions();
      const historySnapshot =
        await client.externalSessions.listAgentHistorySessions();
      expect(usage.reads).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceCount: 1 })])
      );
      expect(snapshot.sessions).toEqual([
        expect.objectContaining({
          key: "codex:worker-session",
          canResume: true
        })
      ]);
      expect(historySnapshot.sessions).toEqual(snapshot.sessions);
      expect(
        client.externalSessions.resolveExternalAgentSession(
          "codex:worker-session"
        )
      ).toMatchObject({
        launch: {
          initialInput: `${formatAgentCommandForShell([
            process.execPath,
            "resume",
            "worker-session"
          ])}\r`
        }
      });

      const reconfigure = client.updateAgentSettings({
        codex: { command: join(homeDir, "missing-codex") }
      });
      expect(
        client.externalSessions.resolveExternalAgentSession(
          "codex:worker-session"
        )
      ).toBeNull();
      await reconfigure;
      const reconfigured =
        await client.externalSessions.listExternalAgentSessions();
      expect(reconfigured.sessions[0]).toMatchObject({
        key: "codex:worker-session",
        canResume: false
      });
    } finally {
      client.close();
    }
  });

  it("does not publish an external-session scan from an older settings generation", async () => {
    const worker = new FakeUsageScanWorker();
    const client = createUsageScanWorkerClient({
      homeDir: "/tmp/kmux-worker-test",
      env: { PATH: process.env.PATH },
      agentSettings: { codex: { command: "old-codex" } },
      forkWorker: () => worker as unknown as ChildProcess
    });

    try {
      const initialRequest =
        client.externalSessions.listExternalAgentSessions();
      await vi.waitFor(() =>
        expect(worker.requestsOfType("init")).toHaveLength(1)
      );
      const init = worker.requestsOfType("init")[0]!;
      worker.respond({ type: "ready", requestId: init.requestId });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("external-sessions-scan")).toHaveLength(1)
      );
      const initialScan = worker.requestsOfType("external-sessions-scan")[0]!;
      worker.respond(
        externalSessionResponse(initialScan, "codex:cached-old", "old-codex")
      );
      await initialRequest;
      expect(
        client.externalSessions.resolveExternalAgentSession("codex:cached-old")
      ).toMatchObject({
        launch: { initialInput: "old-codex resume cached-old\r" }
      });

      const staleRequest = client.externalSessions.listExternalAgentSessions();
      await vi.waitFor(() =>
        expect(worker.requestsOfType("external-sessions-scan")).toHaveLength(2)
      );
      const staleScan = worker.requestsOfType("external-sessions-scan")[1]!;
      const reconfigure = client.updateAgentSettings({
        codex: { command: "current-codex" }
      });
      expect(
        client.externalSessions.resolveExternalAgentSession("codex:cached-old")
      ).toBeNull();

      worker.respond(
        externalSessionResponse(staleScan, "codex:stale-old", "old-codex")
      );
      await vi.waitFor(() =>
        expect(worker.requestsOfType("reconfigure")).toHaveLength(1)
      );
      const reconfigureRequest = worker.requestsOfType("reconfigure")[0]!;
      worker.respond({
        type: "ready",
        requestId: reconfigureRequest.requestId
      });
      await reconfigure;
      await vi.waitFor(() =>
        expect(worker.requestsOfType("external-sessions-scan")).toHaveLength(3)
      );
      const currentScan = worker.requestsOfType("external-sessions-scan")[2]!;
      worker.respond(
        externalSessionResponse(currentScan, "codex:current", "current-codex")
      );

      await expect(staleRequest).resolves.toMatchObject({
        sessions: [{ key: "codex:current" }]
      });
      expect(
        client.externalSessions.resolveExternalAgentSession("codex:stale-old")
      ).toBeNull();
      expect(
        client.externalSessions.resolveExternalAgentSession("codex:current")
      ).toMatchObject({
        launch: { initialInput: "current-codex resume current\r" }
      });
    } finally {
      client.close();
    }
  });

  it("starts an external-session timeout after an earlier usage scan leaves the shared queue", async () => {
    const worker = new FakeUsageScanWorker();
    const client = createUsageScanWorkerClient({
      homeDir: "/tmp/kmux-worker-queue-timeout",
      forkWorker: () => worker as unknown as ChildProcess,
      requestTimeoutMs: 100
    });

    try {
      const usage = client.scan({ startOfDayMs: 0, initial: true });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("init")).toHaveLength(1)
      );
      const init = worker.requestsOfType("init")[0]!;
      worker.respond({ type: "ready", requestId: init.requestId });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("scan")).toHaveLength(1)
      );

      const external = client.externalSessions.listExternalAgentSessions();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(worker.requestsOfType("external-sessions-scan")).toHaveLength(0);
      expect(worker.killed).toBe(false);

      const usageRequest = worker.requestsOfType("scan")[0]!;
      worker.respond({
        type: "scan-result",
        requestId: usageRequest.requestId,
        reads: [],
        failures: []
      });
      await expect(usage).resolves.toEqual({ reads: [], failures: [] });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("external-sessions-scan")).toHaveLength(1)
      );
      const externalRequest = worker.requestsOfType(
        "external-sessions-scan"
      )[0]!;
      worker.respond(
        externalSessionResponse(externalRequest, "codex:after-usage", "codex")
      );

      await expect(external).resolves.toMatchObject({
        sessions: [{ key: "codex:after-usage" }]
      });
    } finally {
      client.close();
    }
  });

  it("starts a reconfigure timeout after an earlier usage scan leaves the shared queue", async () => {
    const worker = new FakeUsageScanWorker();
    const client = createUsageScanWorkerClient({
      homeDir: "/tmp/kmux-worker-reconfigure-queue-timeout",
      forkWorker: () => worker as unknown as ChildProcess,
      requestTimeoutMs: 100
    });

    try {
      const usage = client.scan({ startOfDayMs: 0, initial: true });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("init")).toHaveLength(1)
      );
      const init = worker.requestsOfType("init")[0]!;
      worker.respond({ type: "ready", requestId: init.requestId });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("scan")).toHaveLength(1)
      );

      const reconfigure = client.updateAgentSettings({
        codex: { command: "current-codex" }
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(worker.requestsOfType("reconfigure")).toHaveLength(0);
      expect(worker.killed).toBe(false);

      const initialUsageRequest = worker.requestsOfType("scan")[0]!;
      worker.respond({
        type: "scan-result",
        requestId: initialUsageRequest.requestId,
        reads: [],
        failures: []
      });
      await vi.waitFor(() =>
        expect(worker.requestsOfType("reconfigure")).toHaveLength(1)
      );
      const reconfigureRequest = worker.requestsOfType("reconfigure")[0]!;
      worker.respond({
        type: "ready",
        requestId: reconfigureRequest.requestId
      });
      await expect(reconfigure).resolves.toBeUndefined();

      await vi.waitFor(() =>
        expect(worker.requestsOfType("scan")).toHaveLength(2)
      );
      const currentUsageRequest = worker.requestsOfType("scan")[1]!;
      worker.respond({
        type: "scan-result",
        requestId: currentUsageRequest.requestId,
        reads: [],
        failures: []
      });
      await expect(usage).resolves.toEqual({ reads: [], failures: [] });
    } finally {
      client.close();
    }
  });

  it("terminates a worker when an external-session scan exceeds its existing deadline", async () => {
    const worker = new FakeUsageScanWorker();
    const client = createUsageScanWorkerClient({
      homeDir: "/tmp/kmux-worker-timeout",
      forkWorker: () => worker as unknown as ChildProcess,
      requestTimeoutMs: 100
    });

    const scan = client.externalSessions.listExternalAgentSessions();
    await vi.waitFor(() =>
      expect(worker.requestsOfType("init")).toHaveLength(1)
    );
    const init = worker.requestsOfType("init")[0]!;
    worker.respond({ type: "ready", requestId: init.requestId });
    await vi.waitFor(() =>
      expect(worker.requestsOfType("external-sessions-scan")).toHaveLength(1)
    );

    await expect(scan).rejects.toMatchObject({
      name: "ExternalSessionScanTimeoutError"
    });
    expect(worker.killed).toBe(true);
    client.close();
  });
});

class FakeUsageScanWorker extends EventEmitter {
  private readonly requests: UsageScanWorkerRequest[] = [];
  killed = false;

  send(
    request: UsageScanWorkerRequest,
    callback?: (error: Error | null) => void
  ): boolean {
    this.requests.push(request);
    callback?.(null);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  respond(response: UsageScanWorkerResponse): void {
    this.emit("message", response);
  }

  requestsOfType<T extends UsageScanWorkerRequest["type"]>(
    type: T
  ): Array<Extract<UsageScanWorkerRequest, { type: T }>> {
    return this.requests.filter(
      (request): request is Extract<UsageScanWorkerRequest, { type: T }> =>
        request.type === type
    );
  }
}

function externalSessionResponse(
  request: Extract<UsageScanWorkerRequest, { type: "external-sessions-scan" }>,
  key: string,
  command: string
): Extract<UsageScanWorkerResponse, { type: "external-sessions-scan-result" }> {
  const sessionId = key.slice("codex:".length);
  return {
    type: "external-sessions-scan-result",
    requestId: request.requestId,
    purpose: request.purpose,
    snapshot: {
      updatedAt: "2026-08-18T00:00:00.000Z",
      sessions: [
        {
          key,
          target: { kind: "local" },
          vendor: "codex",
          vendorLabel: "Codex",
          title: sessionId,
          updatedAt: "2026-08-18T00:00:00.000Z",
          relativeTimeLabel: "now",
          canResume: true,
          resumeCommandPreview: `${command} resume ${sessionId}`
        }
      ]
    },
    resumeSpecs: [
      {
        key,
        vendor: "codex",
        agentSessionRef: {
          vendor: "codex",
          externalKey: key,
          sessionId
        },
        title: sessionId,
        target: { kind: "local" },
        launch: { initialInput: `${command} resume ${sessionId}\r` }
      }
    ]
  };
}
