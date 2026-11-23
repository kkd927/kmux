#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { env } from "node:process";

import { Command } from "commander";

import type { Id, JsonRpcEnvelope } from "@kmux/proto";
import { AGENT_HOOK_RPC_TIMEOUT_MS, makeId } from "@kmux/proto";
import { generatedAgentHookResponse } from "@kmux/agents/generated-hook-responses";
import {
  LOCAL_V1_DEFAULT_RUN_LIMITS,
  type AgentLaunchPreferences,
  type JsonValue
} from "@kmux/orchestration";

import { resolveCliSocketPath } from "./socketPath";

const SOCKET_PATH = resolveCliSocketPath({ env });

function sendRpc(
  method: string,
  params?: Record<string, unknown>,
  options: {
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const requestId = makeId("rpc");
    let buffer = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          finish(new Error(`Timed out sending ${method}`));
          socket.destroy();
        }, options.timeoutMs)
      : undefined;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!socket.destroyed) {
        socket.end();
      }
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

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
        if (message.error) {
          finish(new Error(message.error.message));
        } else {
          finish(undefined, message.result);
        }
      }
    });

    socket.on("error", (error) => finish(error));
    socket.on("close", () =>
      finish(
        new Error(
          `Connection closed before ${method} completed; inspect durable state before retrying`
        )
      )
    );
  });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function launchPreferencesFromCli(
  options: { readonly model?: string; readonly effort?: string },
  forceFresh = false
): AgentLaunchPreferences | undefined {
  if (options.effort && !options.model) {
    throw new Error("--effort requires --model");
  }
  if (!options.model && !options.effort) {
    return forceFresh ? {} : undefined;
  }
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {})
  };
}

function agentHookResponse(
  agent: string,
  hookEvent: string,
  outcome: "success" | "fallback"
): Record<string, unknown> {
  return generatedAgentHookResponse(agent, hookEvent, outcome);
}

function readJsonFromStdin(): Record<string, unknown> {
  if (process.stdin.isTTY) {
    return {};
  }

  const input = readFileSync(0, "utf8").trim();
  if (!input) {
    return {};
  }

  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function readJsonFile<T>(path: string): T {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return parsed as T;
}

async function runAgentHook(agent: string, hookEvent: string): Promise<void> {
  let outcome: "success" | "fallback" = "fallback";
  try {
    const payload = readJsonFromStdin();
    await sendRpc(
      "agent.hook",
      {
        agent,
        hookEvent,
        payload,
        workspaceId: env.KMUX_WORKSPACE_ID,
        surfaceId: env.KMUX_SURFACE_ID,
        sessionId: env.KMUX_SESSION_ID
      },
      { timeoutMs: AGENT_HOOK_RPC_TIMEOUT_MS }
    );
    outcome = "success";
  } catch {
    // Agent hooks must never block or fail the agent command path.
  }
  print(agentHookResponse(agent, hookEvent, outcome));
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
  .action(async (options: { workspace?: Id }) =>
    print(
      await sendRpc("surface.list", {
        workspaceId: options.workspace
      })
    )
  );
surface
  .command("split")
  .option("--pane <paneId>")
  .option("--surface <surfaceId>")
  .option("--session <sessionId>")
  .requiredOption("--direction <direction>")
  .action(
    async (options: {
      pane?: Id;
      surface?: Id;
      session?: Id;
      direction: string;
    }) => {
      const useStableCurrentSurface = !options.pane;

      print(
        await sendRpc("surface.split", {
          direction: options.direction,
          paneId: useStableCurrentSurface ? undefined : options.pane,
          surfaceId:
            options.surface ??
            (useStableCurrentSurface ? env.KMUX_SURFACE_ID : undefined),
          sessionId:
            options.session ??
            (useStableCurrentSurface ? env.KMUX_SESSION_ID : undefined)
        })
      );
    }
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
  .option("--operation-id <operationId>")
  .action(async (options) =>
    print(
      await sendRpc("surface.send_text", {
        surfaceId: options.surface,
        text: options.text,
        operationId: options.operationId
      })
    )
  );
surface
  .command("send-key")
  .requiredOption("--surface <surfaceId>")
  .requiredOption("--key <key>")
  .option("--operation-id <operationId>")
  .action(async (options) =>
    print(
      await sendRpc("surface.send_key", {
        surfaceId: options.surface,
        key: options.key,
        operationId: options.operationId
      })
    )
  );
surface
  .command("capture")
  .requiredOption("--surface <surfaceId>")
  .option("--capture-id <captureId>")
  .option("--lines <lineCount>", "number of tail lines", "200")
  .option("--max-bytes <byteCount>", "maximum UTF-8 bytes", "1048576")
  .action(async (options) =>
    print(
      await sendRpc("surface.capture", {
        surfaceId: options.surface,
        captureId: options.captureId,
        lines: Number(options.lines),
        maxBytes: Number(options.maxBytes)
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

const agent = program.command("agent");
agent
  .command("hook")
  .argument("<agent>")
  .argument("<event>")
  .description("Forward a raw agent hook payload from stdin to kmux")
  .action(async (agentName: string, hookEvent: string) => {
    await runAgentHook(agentName, hookEvent);
  });
agent
  .command("event")
  .argument("<agent>")
  .argument("<event>")
  .option("--workspace <workspaceId>")
  .option("--pane <paneId>")
  .option("--surface <surfaceId>")
  .option("--session <sessionId>")
  .option("--title <title>")
  .option("--message <message>")
  .action(async (agentName: string, eventName: string, options) =>
    print(
      await sendRpc("agent.event", {
        workspaceId: options.workspace,
        paneId: options.pane,
        surfaceId: options.surface,
        sessionId: options.session,
        agent: agentName,
        event: eventName,
        title: options.title,
        message: options.message
      })
    )
  );

const system = program.command("system");
system.command("ping").action(async () => print(await sendRpc("system.ping")));
system
  .command("capabilities")
  .action(async () => print(await sendRpc("system.capabilities")));
system
  .command("identify")
  .action(async () => print(await sendRpc("system.identify")));

const orchestration = program.command("orchestration");
orchestration
  .command("run-create")
  .description("Create and select a local orchestration Run")
  .requiredOption("--objective <objective>")
  .option("--run <runId>")
  .action(async (options: { objective: string; run?: string }) => {
    const runId = options.run ?? makeId("run");
    print(
      await sendRpc("orchestration.run.create", {
        runId,
        objective: options.objective,
        inputs: {},
        limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
        idempotencyKey: makeId("create-run")
      })
    );
  });
orchestration
  .command("run-use")
  .requiredOption("--run <runId>")
  .action(async (options: { run: string }) =>
    print(await sendRpc("orchestration.run.use", { runId: options.run }))
  );
orchestration
  .command("run-current")
  .action(async () => print(await sendRpc("orchestration.run.current")));
orchestration
  .command("task-create")
  .requiredOption("--spec <spec>")
  .option("--task <taskId>")
  .option("--title <title>")
  .option("--run <runId>")
  .option("--depends <taskIds>", "comma-separated Task IDs")
  .action(
    async (options: {
      spec: string;
      task?: string;
      title?: string;
      run?: string;
      depends?: string;
    }) =>
      print(
        await sendRpc("orchestration.task.create", {
          ...(options.run ? { runId: options.run } : {}),
          taskId: options.task ?? makeId("task"),
          spec: options.spec,
          ...(options.title ? { title: options.title } : {}),
          dependencies: options.depends
            ? options.depends
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
          requestId: makeId("task-create")
        })
      )
  );
orchestration
  .command("task-list")
  .option("--run <runId>")
  .action(async (options: { run?: string }) =>
    print(
      await sendRpc("orchestration.task.list", {
        ...(options.run ? { runId: options.run } : {})
      })
    )
  );
orchestration
  .command("worker-start")
  .description("Create or dispatch a Task to a native Agent terminal")
  .option("--spec <spec>", "create and dispatch a Task in one call")
  .option("--task <taskId>", "dispatch an existing Task")
  .requiredOption("--agent <agentId>", "Agent catalog ID")
  .option("--run <runId>")
  .option("--title <title>")
  .option("--no-coding", "mark the Task as read-only guidance")
  .option(
    "--worktree <placement>",
    "current, new-child, or new-top-level; omit on retry/reuse"
  )
  .option("--reuse <dispatchId>", "reuse this exact settled Worker session")
  .option("--retry-of <dispatchId>", "retry this exact failed Dispatch")
  .option(
    "--allow-parallel-agent",
    "explicitly allow another Worker using the same Agent in this Run"
  )
  .option("--request-id <requestId>", "idempotent start request ID")
  .option("--model <model>", "opaque provider model identifier")
  .option("--effort <effort>", "opaque provider reasoning effort")
  .action(
    async (options: {
      spec?: string;
      task?: string;
      agent: string;
      run?: string;
      title?: string;
      coding: boolean;
      worktree?: string;
      reuse?: string;
      retryOf?: string;
      allowParallelAgent?: boolean;
      requestId?: string;
      model?: string;
      effort?: string;
    }) => {
      if (Boolean(options.spec) === Boolean(options.task)) {
        throw new Error(
          "worker-start requires exactly one of --spec or --task"
        );
      }
      if (options.retryOf && !options.task) {
        throw new Error("--retry-of requires --task");
      }
      if (options.retryOf && options.reuse) {
        throw new Error("--retry-of cannot be combined with --reuse");
      }
      print(
        await sendRpc(
          "orchestration.worker.start",
          {
            ...(options.run ? { runId: options.run } : {}),
            ...(options.spec ? { spec: options.spec } : {}),
            ...(options.task ? { taskId: options.task } : {}),
            ...(options.title ? { title: options.title } : {}),
            agentId: options.agent,
            coding: options.coding,
            ...(options.worktree ? { worktree: options.worktree } : {}),
            ...(options.reuse ? { reuseDispatchId: options.reuse } : {}),
            ...(options.retryOf ? { retryDispatchId: options.retryOf } : {}),
            allowParallelAgent: options.allowParallelAgent ?? false,
            preferences: launchPreferencesFromCli(options, true) ?? {},
            requestId: options.requestId ?? makeId("worker-start")
          },
          { timeoutMs: 75_000 }
        )
      );
    }
  );
orchestration
  .command("gate-create")
  .description(
    "Dispatch a pending decision Task as a Human Gate; dependent Tasks wait for the user choice"
  )
  .requiredOption("--task <taskId>")
  .requiredOption("--question <question>")
  .requiredOption("--options <json>", "JSON array of allowed resolutions")
  .option("--run <runId>")
  .option("--request-id <requestId>")
  .action(
    async (options: {
      task: string;
      question: string;
      options: string;
      run?: string;
      requestId?: string;
    }) => {
      print(
        await sendRpc("orchestration.gate.create", {
          ...(options.run ? { runId: options.run } : {}),
          taskId: options.task,
          question: options.question,
          options: JSON.parse(options.options),
          requestId: options.requestId ?? makeId("gate-create")
        })
      );
    }
  );
orchestration
  .command("gate-list")
  .option("--run <runId>")
  .option("--task <taskId>")
  .option("--state <state>", "open, resolved, or canceled")
  .action(async (options: { run?: string; task?: string; state?: string }) =>
    print(
      await sendRpc("orchestration.gate.list", {
        ...(options.run ? { runId: options.run } : {}),
        ...(options.task ? { taskId: options.task } : {}),
        ...(options.state ? { state: options.state } : {})
      })
    )
  );
orchestration
  .command("worker-list")
  .option("--run <runId>")
  .option(
    "--terminal-state <state>",
    "active, reclaimable, retained, release-pending, release-unknown, or released"
  )
  .action(async (options: { run?: string; terminalState?: string }) =>
    print(
      await sendRpc("orchestration.worker.list", {
        ...(options.run ? { runId: options.run } : {}),
        ...(options.terminalState
          ? { terminalState: options.terminalState }
          : {})
      })
    )
  );
orchestration
  .command("worker-show")
  .requiredOption("--dispatch <dispatchId>")
  .action(async (options: { dispatch: string }) =>
    print(
      await sendRpc("orchestration.worker.show", {
        dispatchId: options.dispatch
      })
    )
  );
orchestration
  .command("worker-read")
  .description("read live or preserved Worker transcript or terminal output")
  .requiredOption("--dispatch <dispatchId>")
  .option("--lines <lines>", "output lines", "200")
  .option("--max-bytes <bytes>", "output byte limit", "1048576")
  .action(
    async (options: { dispatch: string; lines: string; maxBytes: string }) =>
      print(
        await sendRpc("orchestration.worker.read", {
          dispatchId: options.dispatch,
          lines: Number(options.lines),
          maxBytes: Number(options.maxBytes)
        })
      )
  );
orchestration
  .command("worker-stop")
  .requiredOption("--dispatch <dispatchId>")
  .action(async (options: { dispatch: string }) => {
    const worker = (await sendRpc("orchestration.worker.show", {
      dispatchId: options.dispatch
    })) as { attemptId: string };
    print(
      await sendRpc("orchestration.attempt.cancel", {
        attemptId: worker.attemptId,
        idempotencyKey: makeId("worker-stop")
      })
    );
  });
orchestration
  .command("worker-recover")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--resolution <resolution>")
  .requiredOption("--summary <summary>")
  .action(
    async (options: {
      dispatch: string;
      resolution: string;
      summary: string;
    }) => {
      const worker = (await sendRpc("orchestration.worker.show", {
        dispatchId: options.dispatch
      })) as { attemptId: string };
      print(
        await sendRpc("orchestration.attempt.recover", {
          attemptId: worker.attemptId,
          resolution: options.resolution,
          summary: options.summary
        })
      );
    }
  );
orchestration
  .command("send")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--text <text>")
  .option("--run <runId>")
  .action(async (options: { dispatch: string; text: string; run?: string }) =>
    print(
      await sendRpc("orchestration.message.send", {
        ...(options.run ? { runId: options.run } : {}),
        dispatchId: options.dispatch,
        kind: "guidance",
        text: options.text
      })
    )
  );
orchestration
  .command("ask")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--text <text>")
  .action(async (options: { dispatch: string; text: string }) =>
    print(
      await sendRpc("orchestration.message.ask", {
        dispatchId: options.dispatch,
        text: options.text
      })
    )
  );
orchestration
  .command("escalate")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--text <text>")
  .action(async (options: { dispatch: string; text: string }) =>
    print(
      await sendRpc("orchestration.message.escalate", {
        dispatchId: options.dispatch,
        text: options.text
      })
    )
  );
orchestration
  .command("worker-done")
  .requiredOption("--task <taskId>")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--outcome <outcome>")
  .requiredOption("--summary <summary>")
  .option("--report-path <path>", "optional durable report path")
  .option("--data <json>", "optional structured result JSON")
  .action(
    async (options: {
      task: string;
      dispatch: string;
      outcome: string;
      summary: string;
      reportPath?: string;
      data?: string;
    }) => {
      if (!["succeeded", "failed", "canceled"].includes(options.outcome)) {
        throw new Error("--outcome must be succeeded, failed, or canceled");
      }
      print(
        await sendRpc("orchestration.worker.done", {
          taskId: options.task,
          dispatchId: options.dispatch,
          outcome: options.outcome,
          summary: options.summary,
          ...(options.reportPath ? { reportPath: options.reportPath } : {}),
          ...(options.data ? { data: JSON.parse(options.data) } : {})
        })
      );
    }
  );
orchestration
  .command("heartbeat")
  .requiredOption("--task <taskId>")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--phase <phase>")
  .action(async (options: { task: string; dispatch: string; phase: string }) =>
    print(
      await sendRpc("orchestration.worker.heartbeat", {
        taskId: options.task,
        dispatchId: options.dispatch,
        phase: options.phase
      })
    )
  );
orchestration
  .command("check")
  .description("Receive or wait for one durable mailbox Delivery")
  .option("--run <runId>")
  .option("--dispatch <dispatchId>")
  .option("--wait", "wait for a durable inbox delivery")
  .option("--ack <deliveryId>", "acknowledge a processed delivery")
  .option(
    "--types <csv>",
    "wake for selected event types without skipping earlier FIFO events"
  )
  .option(
    "--summary <text>",
    "record the assessment of the acknowledged delivery"
  )
  .option(
    "--timeout-ms <milliseconds>",
    "bounded wait, up to 60000 ms",
    "30000"
  )
  .action(
    async (options: {
      run?: string;
      dispatch?: string;
      wait?: boolean;
      ack?: string;
      summary?: string;
      types?: string;
      timeoutMs: string;
    }) => {
      if (options.run && options.dispatch) {
        throw new Error("--run and --dispatch are mutually exclusive");
      }
      const timeoutMs = Number(options.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
        throw new Error("--timeout-ms must be between 0 and 60000");
      const types = options.types
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const knownTypes = new Set([
        "caller_task",
        "worker_done",
        "question",
        "escalation",
        "guidance",
        "reply"
      ]);
      if (types?.some((type) => !knownTypes.has(type))) {
        throw new Error("--types contains an unsupported mailbox event type");
      }
      print(
        await sendRpc(
          "orchestration.inbox.check",
          {
            ...(options.run ? { runId: options.run } : {}),
            ...(options.dispatch ? { dispatchId: options.dispatch } : {}),
            wait: options.wait ?? false,
            timeoutMs,
            ...(options.ack ? { ack: options.ack } : {}),
            ...(options.summary ? { summary: options.summary } : {}),
            ...(types && types.length > 0 ? { types } : {})
          },
          { timeoutMs: timeoutMs + 10_000 }
        )
      );
    }
  );
orchestration
  .command("reply")
  .requiredOption("--dispatch <dispatchId>")
  .requiredOption("--reply-to <messageId>")
  .requiredOption("--text <text>")
  .option("--run <runId>")
  .action(
    async (options: {
      run?: string;
      dispatch: string;
      replyTo: string;
      text: string;
    }) =>
      print(
        await sendRpc("orchestration.message.send", {
          ...(options.run ? { runId: options.run } : {}),
          dispatchId: options.dispatch,
          kind: "reply",
          replyToMessageId: options.replyTo,
          text: options.text
        })
      )
  );
for (const disposition of ["retain", "release"] as const) {
  orchestration
    .command(`worker-${disposition}`)
    .requiredOption("--dispatch <dispatchId>")
    .description(
      disposition === "retain"
        ? "Retain the exact Runtime-owned Agent terminal after settlement"
        : "Release the exact Runtime-owned Agent terminal after settlement"
    )
    .action(async (options: { dispatch: string }) => {
      const worker = (await sendRpc("orchestration.worker.show", {
        dispatchId: options.dispatch
      })) as { attemptId: string };
      print(
        await sendRpc("orchestration.input.disposition", {
          attemptId: worker.attemptId,
          disposition,
          idempotencyKey: makeId(`input-${disposition}`)
        })
      );
    });
}

const orchestrationSkill = orchestration.command("skill");
orchestrationSkill
  .command("status")
  .requiredOption("--agents <agentIds>", "comma-separated Agent IDs")
  .action(async (options: { agents: string }) =>
    print(
      await sendRpc("orchestration.skill.status", {
        agentIds: options.agents.split(",").map((value) => value.trim())
      })
    )
  );
const workflow = program.command("workflow");
workflow
  .command("list")
  .action(async () => print(await sendRpc("workflow.list")));
workflow
  .command("create")
  .requiredOption("--name <name>")
  .option("--draft <draftId>")
  .option("--definition <definitionId>")
  .option("--canonical <canonicalFile>")
  .option("--editor <editorFile>")
  .action(
    async (options: {
      name: string;
      draft?: string;
      definition?: string;
      canonical?: string;
      editor?: string;
    }) =>
      print(
        await sendRpc("workflow.draft.create", {
          draftId: options.draft ?? makeId("workflow-draft"),
          definitionId: options.definition ?? makeId("workflow-definition"),
          name: options.name,
          ...(options.canonical
            ? { canonicalDraft: readJsonFile<JsonValue>(options.canonical) }
            : {}),
          ...(options.editor
            ? { editorDocument: readJsonFile<JsonValue>(options.editor) }
            : {})
        })
      )
  );
workflow
  .command("show")
  .requiredOption("--draft <draftId>")
  .action(async (options: { draft: string }) =>
    print(await sendRpc("workflow.draft.get", { draftId: options.draft }))
  );
workflow
  .command("update")
  .requiredOption("--draft <draftId>")
  .requiredOption("--expected-revision <revision>")
  .requiredOption("--canonical <canonicalFile>")
  .requiredOption("--editor <editorFile>")
  .action(
    async (options: {
      draft: string;
      expectedRevision: string;
      canonical: string;
      editor: string;
    }) =>
      print(
        await sendRpc("workflow.draft.update", {
          draftId: options.draft,
          expectedRevision: Number(options.expectedRevision),
          canonicalDraft: readJsonFile<JsonValue>(options.canonical),
          editorDocument: readJsonFile<JsonValue>(options.editor)
        })
      )
  );
workflow
  .command("delete")
  .requiredOption("--draft <draftId>")
  .requiredOption("--expected-revision <revision>")
  .action(async (options: { draft: string; expectedRevision: string }) =>
    print(
      await sendRpc("workflow.draft.delete", {
        draftId: options.draft,
        expectedRevision: Number(options.expectedRevision)
      })
    )
  );
workflow
  .command("validate")
  .requiredOption("--draft <draftId>")
  .action(async (options: { draft: string }) =>
    print(await sendRpc("workflow.draft.validate", { draftId: options.draft }))
  );
workflow
  .command("publish")
  .requiredOption("--draft <draftId>")
  .requiredOption("--expected-revision <revision>")
  .action(async (options: { draft: string; expectedRevision: string }) =>
    print(
      await sendRpc("workflow.publish", {
        draftId: options.draft,
        expectedRevision: Number(options.expectedRevision)
      })
    )
  );
workflow
  .command("run")
  .requiredOption("--workflow <titleOrDefinitionId>")
  .option("--run <runId>")
  .option("--inputs <inputsFile>")
  .action(
    async (options: { workflow: string; run?: string; inputs?: string }) => {
      print(
        await sendRpc("workflow.run", {
          workflow: options.workflow,
          runId: options.run ?? makeId("run"),
          inputs: options.inputs
            ? readJsonFile<Record<string, JsonValue>>(options.inputs)
            : {}
        })
      );
    }
  );

workflow
  .command("caller-done")
  .description("Complete a task received by the existing calling Agent")
  .requiredOption("--run <runId>")
  .requiredOption("--attempt <attemptId>")
  .requiredOption("--request <requestId>")
  .requiredOption(
    "--result <resultFile>",
    "JSON with outcome, summary and declared structured data"
  )
  .action(
    async (options: {
      run: string;
      attempt: string;
      request: string;
      result: string;
    }) => {
      print(
        await sendRpc("workflow.caller.done", {
          runId: options.run,
          attemptId: options.attempt,
          requestId: options.request,
          result: readJsonFile(options.result)
        })
      );
    }
  );

// The desktop bundle also launches this CLI with Electron's executable under
// ELECTRON_RUN_AS_NODE. Commander otherwise applies its Electron argv mode and
// consumes a real kmux subcommand as the application path.
program.parseAsync(process.argv, { from: "node" }).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
