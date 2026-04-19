import { createServer, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import {
  listWorkspaceSurfaceIds,
  type AppAction,
  type AppState
} from "@kmux/core";
import type {
  JsonRpcEnvelope,
  ShellIdentity,
  SplitDirection
} from "@kmux/proto";
import { makeId, normalizeAgentHookInvocation } from "@kmux/proto";
import { ZodError } from "zod";

import {
  UnknownSocketMethodError,
  parseSocketEnvelope,
  parseSocketRequest,
  type ParsedSocketRequest
} from "./socketRpc";

type AgentEventParams = Extract<
  ParsedSocketRequest,
  { method: "agent.event" }
>["params"];

interface SocketServerOptions {
  socketPath: string;
  getState: () => AppState;
  dispatch: (action: AppAction) => void;
  sendSurfaceText: (surfaceId: string, text: string) => void;
  sendSurfaceKey: (surfaceId: string, key: string) => void;
  identify: () => ShellIdentity;
  isSurfaceVisibleToUser?: (surfaceId: string) => boolean;
}

export class KmuxSocketServer {
  private readonly server;

  constructor(private readonly options: SocketServerOptions) {
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  start(): Promise<void> {
    mkdirSync(dirname(this.options.socketPath), { recursive: true });
    rmSync(this.options.socketPath, { force: true });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        this.handleMessage(socket, line);
      }
    });
  }

  private handleMessage(socket: Socket, line: string): void {
    let envelope: ReturnType<typeof parseSocketEnvelope> | undefined;

    try {
      envelope = parseSocketEnvelope(line);
      const parsedEnvelope = envelope;
      const state = this.options.getState();
      const allowed =
        state.settings.socketMode === "allowAll" ||
        (state.settings.socketMode === "kmuxOnly" &&
          Object.values(state.sessions).some(
            (session) => session.authToken === parsedEnvelope.authToken
          ));

      if (!allowed) {
        this.reply(socket, parsedEnvelope.id, undefined, {
          code: -32001,
          message: "Socket access denied for current mode"
        });
        return;
      }

      const request = parseSocketRequest(
        parsedEnvelope.method,
        parsedEnvelope.params,
        parsedEnvelope.id,
        parsedEnvelope.authToken
      );
      const result = this.route(request);
      this.reply(socket, request.id, result);
    } catch (error) {
      if (error instanceof ZodError) {
        this.reply(socket, envelope?.id, undefined, {
          code: envelope ? -32602 : -32600,
          message: error.issues[0]?.message ?? "Invalid request payload"
        });
        return;
      }
      if (error instanceof UnknownSocketMethodError) {
        this.reply(socket, envelope?.id, undefined, {
          code: -32601,
          message: error.message
        });
        return;
      }
      this.reply(socket, envelope?.id, undefined, {
        code: -32603,
        message: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  }

  private route(request: ParsedSocketRequest): unknown {
    const state = this.options.getState();
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const activeWorkspace = state.workspaces[activeWorkspaceId];
    const activePane = state.panes[activeWorkspace.activePaneId];
    const activeSurfaceId = activePane.activeSurfaceId;

    switch (request.method) {
      case "workspace.list":
        return state.windows[state.activeWindowId].workspaceOrder.map(
          (workspaceId) => state.workspaces[workspaceId]
        );
      case "workspace.create":
        this.options.dispatch({
          type: "workspace.create",
          name: request.params.name,
          cwd: request.params.cwd
        });
        return { ok: true };
      case "workspace.select":
        this.options.dispatch({
          type: "workspace.select",
          workspaceId: request.params.workspaceId
        });
        return { ok: true };
      case "workspace.current":
        return activeWorkspace;
      case "workspace.close":
        this.options.dispatch({
          type: "workspace.close",
          workspaceId: request.params.workspaceId
        });
        return { ok: true };
      case "surface.list": {
        const workspaceId = request.params.workspaceId ?? activeWorkspaceId;
        return listWorkspaceSurfaceIds(state, workspaceId).map(
          (surfaceId) => state.surfaces[surfaceId]
        );
      }
      case "surface.split":
        this.options.dispatch({
          type: "pane.split",
          paneId: request.params.paneId,
          direction: request.params.direction as SplitDirection
        });
        return { ok: true };
      case "surface.focus":
        this.options.dispatch({
          type: "surface.focus",
          surfaceId: request.params.surfaceId ?? activeSurfaceId
        });
        return { ok: true };
      case "surface.send_text":
        this.options.sendSurfaceText(
          request.params.surfaceId ?? activeSurfaceId,
          request.params.text
        );
        return { ok: true };
      case "surface.send_key":
        this.options.sendSurfaceKey(
          request.params.surfaceId ?? activeSurfaceId,
          request.params.key
        );
        return { ok: true };
      case "notification.create":
        this.options.dispatch({
          type: "notification.create",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          title: request.params.title,
          message: request.params.message,
          surfaceId: request.params.surfaceId,
          paneId: request.params.paneId
        });
        return { ok: true };
      case "notification.list":
        return state.notifications;
      case "notification.clear":
        this.options.dispatch({
          type: "notification.clear",
          notificationId: request.params.notificationId
        });
        return { ok: true };
      case "sidebar.set_status":
        this.options.dispatch({
          type: "sidebar.setStatus",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          text: request.params.text,
          key: request.params.key,
          label: request.params.label,
          variant: request.params.variant,
          surfaceId: request.params.surfaceId
        });
        return { ok: true };
      case "sidebar.clear_status":
        this.options.dispatch({
          type: "sidebar.clearStatus",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          key: request.params.key
        });
        return { ok: true };
      case "agent.event":
        return this.dispatchAgentEvent(request.params, activeWorkspaceId);
      case "agent.hook": {
        const event = normalizeAgentHookInvocation(
          request.params.agent,
          request.params.hookEvent,
          request.params.payload ?? {},
          {
            KMUX_WORKSPACE_ID: request.params.workspaceId,
            KMUX_PANE_ID: request.params.paneId,
            KMUX_SURFACE_ID: request.params.surfaceId,
            KMUX_SESSION_ID: request.params.sessionId
          }
        );
        if (!event) {
          return { ok: true, handled: false };
        }
        return this.dispatchAgentEvent(event, activeWorkspaceId);
      }
      case "sidebar.set_progress":
        this.options.dispatch({
          type: "sidebar.setProgress",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          progress: {
            value: request.params.value,
            label: request.params.label
          }
        });
        return { ok: true };
      case "sidebar.clear_progress":
        this.options.dispatch({
          type: "sidebar.clearProgress",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId
        });
        return { ok: true };
      case "sidebar.log":
        this.options.dispatch({
          type: "sidebar.log",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          level: request.params.level ?? "info",
          message: request.params.message
        });
        return { ok: true };
      case "sidebar.clear_log":
        this.options.dispatch({
          type: "sidebar.clearLog",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId
        });
        return { ok: true };
      case "sidebar.state":
      case "sidebar_state":
        return activeWorkspace;
      case "system.ping":
        return { pong: true, id: makeId("pong") };
      case "system.capabilities":
        return this.options.identify().capabilities;
      case "system.identify":
        return this.options.identify();
      default:
        throw new Error("Unhandled socket method");
    }
  }

  private reply(
    socket: Socket,
    id: unknown,
    result?: unknown,
    error?: { code: number; message: string }
  ): void {
    const response: JsonRpcEnvelope = {
      jsonrpc: "2.0",
      id: typeof id === "string" ? id : undefined,
      result,
      error
    };
    socket.write(`${JSON.stringify(response)}\n`);
  }

  private dispatchAgentEvent(
    params: AgentEventParams,
    fallbackWorkspaceId: string
  ): { ok: true } {
    logAgentEvent(params, fallbackWorkspaceId);
    const state = this.options.getState();
    const surfaceId =
      params.surfaceId ??
      (params.sessionId ? state.sessions[params.sessionId]?.surfaceId : undefined);
    const details = {
      ...(params.details ?? {}),
      ...(surfaceId && this.options.isSurfaceVisibleToUser?.(surfaceId)
        ? { visibleToUser: true }
        : {})
    };
    this.options.dispatch({
      type: "agent.event",
      workspaceId: params.workspaceId ?? fallbackWorkspaceId,
      paneId: params.paneId,
      surfaceId: params.surfaceId,
      sessionId: params.sessionId,
      agent: params.agent,
      event: params.event,
      title: params.title,
      message: params.message,
      details: Object.keys(details).length > 0 ? details : undefined
    });
    return { ok: true };
  }
}

function logAgentEvent(
  params: AgentEventParams,
  fallbackWorkspaceId: string
): void {
  const workspaceId = params.workspaceId ?? fallbackWorkspaceId;
  const fields = [
    `agent=${params.agent}`,
    `event=${params.event}`,
    `workspace=${workspaceId}`
  ];
  if (params.surfaceId) {
    fields.push(`surface=${params.surfaceId}`);
  }
  if (params.sessionId) {
    fields.push(`session=${params.sessionId}`);
  }
  const rawHookEvent = stringDetail(params.details, "hook_event_name");
  const hookArg = stringDetail(params.details, "kmux_hook_event_arg");
  if (rawHookEvent) {
    fields.push(`hook=${JSON.stringify(rawHookEvent)}`);
  } else if (hookArg) {
    fields.push(`hook=${JSON.stringify(hookArg)}`);
  }
  if (params.message) {
    fields.push(`message=${JSON.stringify(params.message.slice(0, 160))}`);
  }
  console.log(`[Agent Hook] ${fields.join(" ")}`);
}

function stringDetail(
  details: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 160)
    : undefined;
}
