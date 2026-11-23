import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { AGENT_HOOK_RPC_TIMEOUT_MS } from "@kmux/proto";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCliSocketPath } from "./socketPath";

const SPAWNED_CLI_TEST_TIMEOUT_MS = 15_000;
const macOnlyIt = process.platform === "darwin" ? it : it.skip;
const linuxOnlyIt = process.platform === "linux" ? it : it.skip;

describe("kmux cli socket path resolution", () => {
  it("prefers KMUX_SOCKET_PATH over platform defaults", () => {
    expect(
      resolveCliSocketPath({
        env: {
          HOME: "/home/alice",
          KMUX_SOCKET_PATH: "/tmp/kmux-explicit.sock",
          XDG_RUNTIME_DIR: "/run/user/1000"
        },
        homeDir: "/home/alice",
        platform: "linux",
        uid: 1000
      })
    ).toBe("/tmp/kmux-explicit.sock");
  });

  it("uses the shared Linux XDG runtime socket resolver", () => {
    expect(
      resolveCliSocketPath({
        env: {
          HOME: "/home/alice",
          XDG_RUNTIME_DIR: "/run/user/1000"
        },
        homeDir: "/home/alice",
        platform: "linux",
        uid: 1000
      })
    ).toBe("/run/user/1000/kmux/control.sock");
  });

  it("falls back to the shared resolver for empty explicit socket env", () => {
    for (const emptySocketPath of ["", "   "]) {
      expect(
        resolveCliSocketPath({
          env: {
            HOME: "/home/alice",
            KMUX_SOCKET_PATH: emptySocketPath,
            XDG_RUNTIME_DIR: "/run/user/1000"
          },
          homeDir: "/home/alice",
          platform: "linux",
          uid: 1000
        })
      ).toBe("/run/user/1000/kmux/control.sock");
    }
  });
});

describe("kmux native worker-start", () => {
  it(
    "starts a native Worker through the public Task contract and refuses invalid launch flags before RPC",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kmux-worker-cli-"));
      const socketPath = join(root, "control.sock");
      const requests: { method: string; params: Record<string, unknown> }[] =
        [];
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          if (!buffer.includes("\n")) return;
          const request = JSON.parse(buffer.trim());
          requests.push(request);
          socket.end(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { receiptId: "patch:worker" } })}\n`
          );
        });
      });
      server.listen(socketPath);
      await once(server, "listening");
      const cliEntry = fileURLToPath(new URL("./bin.ts", import.meta.url));
      const baseArgs = [
        "orchestration",
        "worker-start",
        "--run",
        "run:existing",
        "--spec",
        "Review the coordinator analysis; do not modify files.",
        "--agent",
        "copilot",
        "--no-coding",
        "--request-id",
        "start:review"
      ];
      const run = async (extra: string[], commandArgs: string[] = baseArgs) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", cliEntry, ...commandArgs, ...extra],
          {
            env: {
              ...process.env,
              KMUX_SOCKET_PATH: socketPath,
              KMUX_AUTH_TOKEN: "fixture-session"
            },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        let stderr = "";
        child.stdout.resume();
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const [code] = await once(child, "close");
        return { code, stderr };
      };
      try {
        expect(await run(["--model", "test-model", "--effort", "low"])).toEqual(
          { code: 0, stderr: "" }
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]!.method).toBe("orchestration.worker.start");
        const {
          authToken,
          callerPid: _callerPid,
          ...params
        } = requests[0]!.params;
        expect(authToken).toBe("fixture-session");
        expect(params).toMatchObject({
          runId: "run:existing",
          spec: "Review the coordinator analysis; do not modify files.",
          agentId: "copilot",
          coding: false,
          allowParallelAgent: false,
          preferences: { model: "test-model", effort: "low" },
          requestId: "start:review"
        });
        expect((await run(["--effort", "low"])).code).not.toBe(0);
        expect(
          (
            await run([
              "--model",
              "test-model",
              "--terminal",
              "surface:existing"
            ])
          ).code
        ).not.toBe(0);
        expect(requests).toHaveLength(1);

        expect(
          await run(
            [],
            [
              "orchestration",
              "worker-start",
              "--run",
              "run:existing",
              "--task",
              "task:review",
              "--retry-of",
              "dispatch:failed",
              "--agent",
              "copilot",
              "--request-id",
              "retry:review"
            ]
          )
        ).toEqual({ code: 0, stderr: "" });
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({
          method: "orchestration.worker.start",
          params: {
            runId: "run:existing",
            taskId: "task:review",
            retryDispatchId: "dispatch:failed",
            agentId: "copilot",
            allowParallelAgent: false,
            requestId: "retry:review"
          }
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );
});

describe("kmux durable mailbox CLI", () => {
  it(
    "routes Worker check filters, escalation, and terminal-state inventory",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kmux-mailbox-cli-"));
      const socketPath = join(root, "control.sock");
      const requests: { method: string; params: Record<string, unknown> }[] =
        [];
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          if (!buffer.includes("\n")) return;
          const request = JSON.parse(buffer.trim());
          requests.push(request);
          socket.end(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`
          );
        });
      });
      server.listen(socketPath);
      await once(server, "listening");
      const cliEntry = fileURLToPath(new URL("./bin.ts", import.meta.url));
      const run = async (args: string[]) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", cliEntry, "orchestration", ...args],
          {
            env: {
              ...process.env,
              KMUX_SOCKET_PATH: socketPath,
              KMUX_AUTH_TOKEN: "fixture-session"
            },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        let stderr = "";
        child.stdout.resume();
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const [code] = await once(child, "close");
        return { code, stderr };
      };
      try {
        expect(
          await run([
            "check",
            "--dispatch",
            "dispatch:1",
            "--wait",
            "--types",
            "reply,guidance",
            "--ack",
            "delivery:1"
          ])
        ).toEqual({ code: 0, stderr: "" });
        expect(requests[0]).toMatchObject({
          method: "orchestration.inbox.check",
          params: {
            dispatchId: "dispatch:1",
            wait: true,
            types: ["reply", "guidance"],
            ack: "delivery:1"
          }
        });
        expect(
          await run([
            "escalate",
            "--dispatch",
            "dispatch:1",
            "--text",
            "blocked"
          ])
        ).toEqual({ code: 0, stderr: "" });
        expect(requests[1]).toMatchObject({
          method: "orchestration.message.escalate",
          params: { dispatchId: "dispatch:1", text: "blocked" }
        });
        expect(
          await run(["worker-list", "--terminal-state", "reclaimable"])
        ).toEqual({ code: 0, stderr: "" });
        expect(requests[2]).toMatchObject({
          method: "orchestration.worker.list",
          params: { terminalState: "reclaimable" }
        });
        expect(
          (await run(["check", "--run", "run:1", "--dispatch", "dispatch:1"]))
            .code
        ).not.toBe(0);
        const reportPath = "/tmp/review files/$(literal) `report`.md";
        expect(
          await run([
            "worker-done",
            "--task",
            "task:1",
            "--dispatch",
            "dispatch:1",
            "--outcome",
            "succeeded",
            "--summary",
            "Reviewed; findings recorded; nothing remains.",
            "--report-path",
            reportPath
          ])
        ).toEqual({ code: 0, stderr: "" });
        expect(requests[3]).toMatchObject({
          method: "orchestration.worker.done",
          params: { taskId: "task:1", dispatchId: "dispatch:1", reportPath }
        });
        expect(
          await run([
            "heartbeat",
            "--task",
            "task:1",
            "--dispatch",
            "dispatch:1",
            "--phase",
            "Reviewing sources"
          ]).then((result) => result.code)
        ).toBe(0);
        expect(requests[4]).toMatchObject({
          method: "orchestration.worker.heartbeat",
          params: {
            taskId: "task:1",
            dispatchId: "dispatch:1",
            phase: "Reviewing sources"
          }
        });
        expect(requests).toHaveLength(5);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );
});

describe("kmux cli agent hook forwarding", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function expectWorkspaceCurrentViaDefaultSocket({
    homeDir,
    env,
    socketPath
  }: {
    homeDir: string;
    env: NodeJS.ProcessEnv;
    socketPath: string;
  }) {
    mkdirSync(dirname(socketPath), { recursive: true });
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
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request?.id,
              result: { ok: true }
            })}\n`
          );
          socket.end();
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
      const child = spawn(
        process.execPath,
        ["--import", "tsx", cliEntry, "workspace", "current"],
        {
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          env: {
            ...process.env,
            ...env,
            HOME: homeDir,
            KMUX_SOCKET_PATH: undefined,
            KMUX_RUNTIME_DIR: undefined
          },
          stdio: ["ignore", "pipe", "pipe"]
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

      const [exitCode] = (await once(child, "close")) as [number | null];

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(JSON.stringify({ ok: true }, null, 2));
      expect(stderr).toBe("");
      expect(request).toMatchObject({
        jsonrpc: "2.0",
        method: "workspace.current"
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it(
    "waits for delayed hook replies within the shared timeout budget",
    async () => {
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
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );

  macOnlyIt(
    "uses the macOS home socket resolver when KMUX_SOCKET_PATH is absent",
    async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "kmux-cli-home-test-"));
      tempDirs.push(homeDir);
      const socketPath = join(homeDir, ".kmux", "control.sock");

      await expectWorkspaceCurrentViaDefaultSocket({
        homeDir,
        env: {},
        socketPath
      });
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );

  linuxOnlyIt(
    "uses the Linux XDG runtime socket resolver when KMUX_SOCKET_PATH is absent",
    async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "kmux-cli-home-test-"));
      tempDirs.push(homeDir);
      const runtimeDir = join(homeDir, "runtime");
      const socketPath = join(runtimeDir, "kmux", "control.sock");

      await expectWorkspaceCurrentViaDefaultSocket({
        homeDir,
        env: { XDG_RUNTIME_DIR: runtimeDir },
        socketPath
      });
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );

  it(
    "uses an explicit pane context when surface split receives --pane",
    async () => {
      const socketDir = mkdtempSync(join(tmpdir(), "kmux-cli-split-test-"));
      tempDirs.push(socketDir);
      const socketPath = join(socketDir, "split.sock");
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
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request?.id,
                result: { ok: true }
              })}\n`
            );
            socket.end();
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
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            cliEntry,
            "surface",
            "split",
            "--pane",
            "pane_spawn",
            "--direction",
            "right"
          ],
          {
            cwd: fileURLToPath(new URL("../../..", import.meta.url)),
            env: {
              ...process.env,
              KMUX_SOCKET_PATH: socketPath,
              KMUX_SURFACE_ID: "surface_live",
              KMUX_SESSION_ID: "session_live"
            },
            stdio: ["ignore", "pipe", "pipe"]
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

        const [exitCode] = (await once(child, "close")) as [number | null];

        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe(JSON.stringify({ ok: true }, null, 2));
        expect(stderr).toBe("");
        expect(request).toMatchObject({
          jsonrpc: "2.0",
          method: "surface.split",
          params: {
            direction: "right",
            paneId: "pane_spawn"
          }
        });
        expect(request?.params).not.toHaveProperty("surfaceId");
        expect(request?.params).not.toHaveProperty("sessionId");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );

  it(
    "maps scoped CLI IDs and preserves active-workspace list defaults",
    async () => {
      const socketDir = mkdtempSync(join(tmpdir(), "kmux-cli-control-test-"));
      tempDirs.push(socketDir);
      const socketPath = join(socketDir, "control.sock");
      const cliEntry = fileURLToPath(new URL("./bin.ts", import.meta.url));
      const requests: Array<{
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      }> = [];
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line) as (typeof requests)[number];
            requests.push(request);
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result:
                  request.method === "surface.capture"
                    ? { captureId: "capture_1", text: "captured" }
                    : request.method === "surface.list"
                      ? []
                      : { operationId: "operation_1", boundary: "pty-write" }
              })}\n`
            );
            socket.end();
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

      const runCli = async (args: string[]): Promise<string> => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", cliEntry, ...args],
          {
            cwd: fileURLToPath(new URL("../../..", import.meta.url)),
            env: { ...process.env, KMUX_SOCKET_PATH: socketPath },
            stdio: ["ignore", "pipe", "pipe"]
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
        const [exitCode] = (await once(child, "close")) as [number | null];
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        return stdout.trim();
      };

      try {
        expect(
          JSON.parse(
            await runCli(["surface", "list", "--workspace", "workspace_1"])
          )
        ).toEqual([]);
        expect(JSON.parse(await runCli(["surface", "list"]))).toEqual([]);
        expect(
          JSON.parse(
            await runCli([
              "surface",
              "send-text",
              "--surface",
              "surface_1",
              "--text",
              "hello",
              "--operation-id",
              "operation_1"
            ])
          )
        ).toEqual({ operationId: "operation_1", boundary: "pty-write" });
        expect(
          JSON.parse(
            await runCli([
              "surface",
              "capture",
              "--surface",
              "surface_1",
              "--capture-id",
              "capture_1",
              "--lines",
              "321",
              "--max-bytes",
              "8192"
            ])
          )
        ).toEqual({ captureId: "capture_1", text: "captured" });
        expect(requests).toEqual([
          expect.objectContaining({
            method: "surface.list",
            params: expect.objectContaining({
              workspaceId: "workspace_1"
            })
          }),
          expect.objectContaining({
            method: "surface.list",
            params: expect.not.objectContaining({
              workspaceId: expect.anything()
            })
          }),
          expect.objectContaining({
            method: "surface.send_text",
            params: expect.objectContaining({
              surfaceId: "surface_1",
              text: "hello",
              operationId: "operation_1"
            })
          }),
          expect.objectContaining({
            method: "surface.capture",
            params: expect.objectContaining({
              surfaceId: "surface_1",
              captureId: "capture_1",
              lines: 321,
              maxBytes: 8192
            })
          })
        ]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );

  it(
    "emits Antigravity-compatible hook JSON for gating events",
    async () => {
      const socketDir = mkdtempSync(join(tmpdir(), "kmux-cli-agy-hook-test-"));
      tempDirs.push(socketDir);
      const cliEntry = fileURLToPath(new URL("./bin.ts", import.meta.url));
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          cliEntry,
          "agent",
          "hook",
          "antigravity",
          "PreToolUse"
        ],
        {
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          env: {
            ...process.env,
            KMUX_SOCKET_PATH: join(socketDir, "missing.sock")
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
      child.stdin.end(
        JSON.stringify({
          toolCall: {
            name: "ask_permission"
          }
        })
      );

      const [exitCode] = (await once(child, "close")) as [number | null];

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ decision: "allow" });
      expect(stderr).toBe("");
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );
});

describe("saved Workflow CLI", () => {
  it(
    "invokes by title and submits a saved typed result from the caller contract",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kmux-workflow-cli-"));
      const socketPath = join(root, "control.sock");
      const requests: Array<{
        method: string;
        params: Record<string, unknown>;
      }> = [];
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          if (!buffer.includes("\n")) return;
          const request = JSON.parse(buffer.trim());
          requests.push(request);
          socket.end(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { runId: "run:test" } })}\n`
          );
        });
      });
      server.listen(socketPath);
      await once(server, "listening");
      const inputs = join(root, "inputs.json");
      const resultFile = join(root, "result.json");
      writeFileSync(inputs, JSON.stringify({ task: "Review" }));
      const result = {
        outcome: "succeeded",
        summary: "Verified",
        data: { remaining: 0 }
      };
      writeFileSync(resultFile, JSON.stringify(result));
      const cli = fileURLToPath(new URL("./bin.ts", import.meta.url));
      const run = async (args: string[]) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", cli, "workflow", ...args],
          {
            env: {
              ...process.env,
              KMUX_SOCKET_PATH: socketPath,
              KMUX_AUTH_TOKEN: "caller-token"
            },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        child.stdout.resume();
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const [code] = await once(child, "close");
        return { code, stderr };
      };
      try {
        expect(
          await run([
            "run",
            "--workflow",
            "코드 리뷰 2회",
            "--run",
            "run:test",
            "--inputs",
            inputs
          ])
        ).toMatchObject({ code: 0 });
        expect(requests[0]).toMatchObject({
          method: "workflow.run",
          params: {
            workflow: "코드 리뷰 2회",
            runId: "run:test",
            inputs: { task: "Review" }
          }
        });
        expect(
          await run([
            "caller-done",
            "--run",
            "run:test",
            "--attempt",
            "attempt:test",
            "--request",
            "request:test",
            "--result",
            resultFile
          ])
        ).toMatchObject({ code: 0 });
        expect(requests[1]).toMatchObject({
          method: "workflow.caller.done",
          params: {
            runId: "run:test",
            attemptId: "attempt:test",
            requestId: "request:test",
            result
          }
        });
        expect((await run(["run", "--version", "old-version"])).code).not.toBe(
          0
        );
        expect(requests).toHaveLength(2);
      } finally {
        server.close();
        await once(server, "close");
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWNED_CLI_TEST_TIMEOUT_MS
  );
});
