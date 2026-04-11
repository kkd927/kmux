#!/usr/bin/env node

import { Socket } from "node:net";
import { env } from "node:process";

import { Command } from "commander";

import type { Id, JsonRpcEnvelope } from "@kmux/proto";
import { makeId } from "@kmux/proto";

const SOCKET_PATH = env.KMUX_SOCKET_PATH ?? `${env.HOME}/.kmux/control.sock`;

function sendRpc(
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const requestId = makeId("rpc");
    let buffer = "";

    socket.connect(SOCKET_PATH, () => {
      const payload: JsonRpcEnvelope = {
        jsonrpc: "2.0",
        id: requestId,
        method,
        params: {
          ...params,
          authToken: env.KMUX_AUTH_TOKEN
        }
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line) as JsonRpcEnvelope;
        if (message.id !== requestId) {
          continue;
        }
        socket.end();
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      }
    });

    socket.on("error", reject);
  });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const program = new Command();
program.name("kmux");

const workspace = program.command("workspace");
workspace
  .command("list")
  .action(async () => print(await sendRpc("workspace.list")));
workspace
  .command("create")
  .option("--name <name>")
  .option("--cwd <cwd>")
  .action(async (options) => print(await sendRpc("workspace.create", options)));
workspace
  .command("select")
  .requiredOption("--workspace <workspaceId>")
  .action(async (options: { workspace: Id }) =>
    print(await sendRpc("workspace.select", { workspaceId: options.workspace }))
  );
workspace
  .command("current")
  .action(async () => print(await sendRpc("workspace.current")));
workspace
  .command("close")
  .requiredOption("--workspace <workspaceId>")
  .action(async (options: { workspace: Id }) =>
    print(await sendRpc("workspace.close", { workspaceId: options.workspace }))
  );

const surface = program.command("surface");
surface
  .command("list")
  .option("--workspace <workspaceId>")
  .action(async (options) => print(await sendRpc("surface.list", options)));
surface
  .command("split")
  .requiredOption("--pane <paneId>")
  .requiredOption("--direction <direction>")
  .action(async (options) =>
    print(
      await sendRpc("surface.split", {
        paneId: options.pane,
        direction: options.direction
      })
    )
  );
surface
  .command("focus")
  .requiredOption("--surface <surfaceId>")
  .action(async (options) =>
    print(await sendRpc("surface.focus", { surfaceId: options.surface }))
  );
surface
  .command("send-text")
  .requiredOption("--surface <surfaceId>")
  .requiredOption("--text <text>")
  .action(async (options) =>
    print(
      await sendRpc("surface.send_text", {
        surfaceId: options.surface,
        text: options.text
      })
    )
  );
surface
  .command("send-key")
  .requiredOption("--surface <surfaceId>")
  .requiredOption("--key <key>")
  .action(async (options) =>
    print(
      await sendRpc("surface.send_key", {
        surfaceId: options.surface,
        key: options.key
      })
    )
  );

const notification = program.command("notification");
notification
  .command("create")
  .requiredOption("--workspace <workspaceId>")
  .requiredOption("--title <title>")
  .requiredOption("--message <message>")
  .action(async (options) =>
    print(
      await sendRpc("notification.create", {
        workspaceId: options.workspace,
        title: options.title,
        message: options.message
      })
    )
  );
notification
  .command("list")
  .action(async () => print(await sendRpc("notification.list")));
notification
  .command("clear")
  .option("--notification <notificationId>")
  .action(async (options) =>
    print(
      await sendRpc("notification.clear", {
        notificationId: options.notification
      })
    )
  );

const sidebar = program.command("sidebar");
sidebar
  .command("set-status")
  .requiredOption("--workspace <workspaceId>")
  .requiredOption("--text <text>")
  .action(async (options) =>
    print(
      await sendRpc("sidebar.set_status", {
        workspaceId: options.workspace,
        text: options.text
      })
    )
  );
sidebar
  .command("clear-status")
  .requiredOption("--workspace <workspaceId>")
  .action(async (options) =>
    print(
      await sendRpc("sidebar.clear_status", { workspaceId: options.workspace })
    )
  );
sidebar
  .command("set-progress")
  .requiredOption("--workspace <workspaceId>")
  .requiredOption("--value <value>")
  .option("--label <label>")
  .action(async (options) =>
    print(
      await sendRpc("sidebar.set_progress", {
        workspaceId: options.workspace,
        value: Number(options.value),
        label: options.label
      })
    )
  );
sidebar
  .command("clear-progress")
  .requiredOption("--workspace <workspaceId>")
  .action(async (options) =>
    print(
      await sendRpc("sidebar.clear_progress", {
        workspaceId: options.workspace
      })
    )
  );
sidebar
  .command("log")
  .requiredOption("--workspace <workspaceId>")
  .requiredOption("--message <message>")
  .option("--level <level>", "info")
  .action(async (options) =>
    print(
      await sendRpc("sidebar.log", {
        workspaceId: options.workspace,
        level: options.level,
        message: options.message
      })
    )
  );
sidebar
  .command("clear-log")
  .requiredOption("--workspace <workspaceId>")
  .action(async (options) =>
    print(
      await sendRpc("sidebar.clear_log", { workspaceId: options.workspace })
    )
  );
sidebar
  .command("state")
  .action(async () => print(await sendRpc("sidebar.state")));

const system = program.command("system");
system.command("ping").action(async () => print(await sendRpc("system.ping")));
system
  .command("capabilities")
  .action(async () => print(await sendRpc("system.capabilities")));
system
  .command("identify")
  .action(async () => print(await sendRpc("system.identify")));

program.parseAsync().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
