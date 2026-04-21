import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

import { AGENT_HOOK_RPC_TIMEOUT_MS } from "@kmux/proto";
import { afterEach, describe, expect, it } from "vitest";

describe("kmux cli agent hook forwarding", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for delayed hook replies within the shared timeout budget", async () => {
    expect(AGENT_HOOK_RPC_TIMEOUT_MS).toBeGreaterThan(900);

    const socketDir = mkdtempSync(join(tmpdir(), "kmux-cli-hook-test-"));
    tempDirs.push(socketDir);
    const socketPath = join(socketDir, "hook.sock");
    const cliEntry = fileURLToPath(new URL("./bin.ts", import.meta.url));
    let request:
      | {
          jsonrpc?: string;
          method?: string;
          params?: Record<string, unknown>;
          id?: string;
        }
      | undefined;

    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          request = JSON.parse(line) as typeof request;
          setTimeout(() => {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request?.id,
                result: { ok: true }
              })}\n`
            );
            socket.end();
          }, 900);
        }
      });
      socket.on("error", () => {});
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const startedAt = Date.now();
      const child = spawn(
        process.execPath,
        ["--import", "tsx", cliEntry, "agent", "hook", "codex", "Stop"],
        {
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          env: {
            ...process.env,
            KMUX_SOCKET_PATH: socketPath,
            KMUX_WORKSPACE_ID: "workspace_1",
            KMUX_SURFACE_ID: "surface_1",
            KMUX_SESSION_ID: "session_1"
          },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.stdin.end(JSON.stringify({ message: "Done" }));

      const [exitCode] = (await once(child, "close")) as [number | null];
      const elapsedMs = Date.now() - startedAt;

      expect(exitCode).toBe(0);
      expect(elapsedMs).toBeGreaterThanOrEqual(850);
      expect(stdout.trim()).toBe("{}");
      expect(stderr).toBe("");
      expect(request).toMatchObject({
        jsonrpc: "2.0",
        method: "agent.hook",
        params: {
          agent: "codex",
          hookEvent: "Stop",
          workspaceId: "workspace_1",
          surfaceId: "surface_1",
          sessionId: "session_1",
          payload: {
            message: "Done"
          }
        }
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
