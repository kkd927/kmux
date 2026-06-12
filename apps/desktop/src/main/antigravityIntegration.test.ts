import {
  spawn,
  type ChildProcess
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAgentStorageRoots } from "@kmux/metadata";

import {
  antigravitySessionIndexPath,
  ensureAntigravityHooksInstalled,
  recordAntigravitySessionFromHook
} from "./antigravityIntegration";
import { writeAgentHookHelpers } from "../pty-host/shellIntegration";

function createSandboxHome(): string {
  return mkdtempSync(join(tmpdir(), "kmux-antigravity-integration-"));
}

const sandboxDirs: string[] = [];

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
});

describe("antigravitySessionIndexPath", () => {
  it("treats a blank KMUX_CONFIG_DIR as absent", () => {
    expect(
      antigravitySessionIndexPath("/home/test", {
        KMUX_CONFIG_DIR: "   "
      })
    ).toBe("/home/test/.config/kmux/antigravity-sessions.json");
  });

  it("trims a configured KMUX_CONFIG_DIR before deriving the index path", () => {
    expect(
      antigravitySessionIndexPath("/home/test", {
        KMUX_CONFIG_DIR: " /profiles/kmux/config "
      })
    ).toBe("/profiles/kmux/config/antigravity-sessions.json");
  });

  it("ignores relative config and home paths instead of deriving cwd-relative indexes", () => {
    expect(
      antigravitySessionIndexPath("relative-home", {
        KMUX_CONFIG_DIR: " profiles/kmux/config "
      })
    ).toBe(join(homedir(), ".config", "kmux", "antigravity-sessions.json"));
  });
});

describe("ensureAntigravityHooksInstalled", () => {
  it("uses AgentStorageRoots for the Antigravity hooks path", () => {
    const homeDir = createSandboxHome();
    const storageHomeDir = createSandboxHome();
    sandboxDirs.push(homeDir, storageHomeDir);
    const roots = resolveAgentStorageRoots({
      homeDir: storageHomeDir
    });

    const result = ensureAntigravityHooksInstalled(homeDir, {
      agentStorageRoots: roots
    });

    expect(result.changed).toBe(true);
    expect(result.hooksPath).toBe(roots.antigravity.hooksPath);
    expect(existsSync(roots.antigravity.hooksPath)).toBe(true);
    expect(existsSync(join(homeDir, ".gemini", "config", "hooks.json"))).toBe(
      false
    );
  });

  it("installs a kmux-managed global Antigravity hook entry", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);

    const socketPath = join(homeDir, ".kmux", "control.sock");
    const agentBinDir = join(homeDir, ".config", "kmux", "bin");

    const result = ensureAntigravityHooksInstalled(homeDir, {
      socketPath,
      agentBinDir
    });

    expect(result.changed).toBe(true);
    const hooksPath = join(homeDir, ".gemini", "config", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      "kmux-antigravity": Record<string, unknown>;
    };
    const managed = hooks["kmux-antigravity"] as {
      PreInvocation: unknown[];
      PreToolUse: Array<{
        matcher?: string;
        hooks: Array<{ command?: string }>;
      }>;
      PostToolUse: Array<{
        matcher?: string;
        hooks: Array<{ command?: string }>;
      }>;
      PostInvocation: unknown[];
      Stop: unknown[];
    };

    expect(managed.PreInvocation).toHaveLength(1);
    expect(managed.PreToolUse).toHaveLength(1);
    expect(managed.PostToolUse).toHaveLength(1);
    expect(managed.PostInvocation).toHaveLength(1);
    expect(managed.Stop).toHaveLength(1);
    expect(managed.PreToolUse[0].matcher).toBe(".*");
    expect(JSON.stringify(managed)).toContain(
      "KMUX_MANAGED_ANTIGRAVITY_HOOK=1"
    );
    expect(
      (managed.PreInvocation[0] as { command?: string }).command
    ).toContain("$_kmux_agent_bin_dir/kmux-agent-hook");
    expect(
      (managed.PreInvocation[0] as { command?: string }).command
    ).toContain(
      `if [ "\${_kmux_socket_path_env#/}" != "$_kmux_socket_path_env" ]; then _kmux_socket_path="$_kmux_socket_path_env"; else _kmux_socket_path='${socketPath}'`
    );
    expect(
      (managed.PreInvocation[0] as { command?: string }).command
    ).toContain(
      `if [ "\${_kmux_agent_bin_dir_env#/}" != "$_kmux_agent_bin_dir_env" ]; then _kmux_agent_bin_dir="$_kmux_agent_bin_dir_env"; else _kmux_agent_bin_dir='${agentBinDir}'`
    );
    expect(
      (managed.PreInvocation[0] as { command?: string }).command
    ).toContain("antigravity PreInvocation");
    expect(
      (managed.PreInvocation[0] as { command?: string }).command
    ).toContain("printf '%s\\n' '{}'");
    expect(managed.PreToolUse[0].hooks[0].command).toContain(
      "printf '%s\\n' '{\"decision\":\"allow\"}'"
    );
  });

  it(
    "routes a global hook to kmux through installed fallback paths when inherited env is relative",
    async () => {
      const homeDir = createSandboxHome();
      sandboxDirs.push(homeDir);
      const socketPath = join(homeDir, ".kmux", "control.sock");
      const agentBinDir = join(homeDir, ".config", "kmux", "bin");
      mkdirSync(join(homeDir, ".kmux"), { recursive: true });
      writeAgentHookHelpers(agentBinDir);
      ensureAntigravityHooksInstalled(homeDir, {
        socketPath,
        agentBinDir
      });

      let resolveReceived!: (message: Record<string, unknown>) => void;
      const received = new Promise<Record<string, unknown>>((resolve) => {
        resolveReceived = resolve;
      });
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const line = buffer.split("\n")[0];
          if (!line) {
            return;
          }
          const parsed = JSON.parse(line) as { id?: unknown };
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: { ok: true }
            })}\n`
          );
          server.close();
          resolveReceived(parsed as Record<string, unknown>);
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      const hooksPath = join(homeDir, ".gemini", "config", "hooks.json");
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        "kmux-antigravity": {
          PreInvocation: Array<{ command: string }>;
        };
      };
      const output = await runHookCommand(
        hooks["kmux-antigravity"].PreInvocation[0].command,
        {
          conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
          workspacePaths: ["/Users/test/antigravity-project"],
          transcriptPath:
            "/Users/test/antigravity-project/.gemini/jetski/transcript.jsonl",
          artifactDirectoryPath:
            "/Users/test/antigravity-project/.gemini/jetski/artifacts"
        },
        {
          KMUX_SOCKET_PATH: "relative.sock",
          KMUX_AGENT_BIN_DIR: "relative-hooks"
        }
      );

      await expect(received).resolves.toMatchObject({
        method: "agent.hook",
        params: {
          agent: "antigravity",
          hookEvent: "PreInvocation",
          payload: {
            conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
          }
        }
      });
      expect(output).toBe("{}\n");
    },
    20_000
  );

  it("preserves user hooks, removes duplicate managed hooks, and is idempotent", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);
    const hooksPath = join(homeDir, ".gemini", "config", "hooks.json");
    mkdirSync(join(homeDir, ".gemini", "config"), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          "user-linter": {
            PostToolUse: [
              {
                matcher: "run_command",
                hooks: [{ type: "command", command: "echo user-linter" }]
              },
              {
                matcher: ".*",
                hooks: [
                  {
                    type: "command",
                    command:
                      'KMUX_MANAGED_ANTIGRAVITY_HOOK=1; "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" antigravity PostToolUse || true'
                  }
                ]
              }
            ]
          },
          "kmux-antigravity": {
            Stop: [
              {
                type: "command",
                command:
                  'KMUX_MANAGED_ANTIGRAVITY_HOOK=1; "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" antigravity Stop || true'
              },
              {
                type: "command",
                command:
                  'KMUX_MANAGED_ANTIGRAVITY_HOOK=1; "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" antigravity Stop || true'
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const firstResult = ensureAntigravityHooksInstalled(homeDir);
    const secondResult = ensureAntigravityHooksInstalled(homeDir);
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<
      string,
      {
        PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
        Stop?: Array<{ command?: string }>;
      }
    >;

    expect(firstResult.changed).toBe(true);
    expect(secondResult.changed).toBe(false);
    expect(hooks["user-linter"].PostToolUse).toHaveLength(1);
    expect(hooks["user-linter"].PostToolUse?.[0].hooks?.[0].command).toBe(
      "echo user-linter"
    );
    expect(
      JSON.stringify(hooks).match(/KMUX_MANAGED_ANTIGRAVITY_HOOK=1/g)
    )?.toHaveLength(5);
  });
});

function runHookCommand(
  command: string,
  payload: Record<string, unknown>,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides,
      KMUX_NODE_PATH: process.execPath
    };
    if (!("KMUX_SOCKET_PATH" in envOverrides)) {
      delete env.KMUX_SOCKET_PATH;
    }
    if (!("KMUX_AGENT_BIN_DIR" in envOverrides)) {
      delete env.KMUX_AGENT_BIN_DIR;
    }
    const child: ChildProcess = spawn("/bin/sh", ["-c", command], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`hook command exited ${code}: ${stderr}`));
    });
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

describe("recordAntigravitySessionFromHook", () => {
  it("records only Antigravity hook metadata in the kmux session index", () => {
    const homeDir = createSandboxHome();
    sandboxDirs.push(homeDir);
    const indexPath = join(
      homeDir,
      ".config",
      "kmux",
      "antigravity-sessions.json"
    );

    recordAntigravitySessionFromHook({
      indexPath,
      agent: "antigravity-cli",
      payload: {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        workspacePaths: ["/Users/test/project"],
        transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
        artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
        ignoredPrompt: "Do not write this"
      },
      now: () => new Date("2026-06-02T02:00:00.000Z")
    });

    recordAntigravitySessionFromHook({
      indexPath,
      agent: "agy",
      payload: {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
      },
      now: () => new Date("2026-06-02T02:05:00.000Z")
    });

    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(index.sessions).toEqual([
      {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        cwd: "/Users/test/project",
        workspacePaths: ["/Users/test/project"],
        transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
        artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
        createdAt: "2026-06-02T02:00:00.000Z",
        updatedAt: "2026-06-02T02:05:00.000Z"
      }
    ]);
    expect(JSON.stringify(index)).not.toContain("Do not write this");
  });
});
