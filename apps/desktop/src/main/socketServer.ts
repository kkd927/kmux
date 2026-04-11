import { createServer, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { AppAction, AppState } from "@kmux/core";
import type {
  JsonRpcEnvelope,
  ShellIdentity,
  SplitDirection
} from "@kmux/proto";
import { makeId } from "@kmux/proto";

interface SocketServerOptions {
  socketPath: string;
  getState: () => AppState;
  dispatch: (action: AppAction) => void;
  sendSurfaceText: (surfaceId: string, text: string) => void;
  sendSurfaceKey: (surfaceId: string, key: string) => void;
  identify: () => ShellIdentity;
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
    try {
      const message = JSON.parse(line) as JsonRpcEnvelope<
        Record<string, unknown>
      >;
      const authToken = message.params?.authToken as string | undefined;
      const state = this.options.getState();
      const allowed =
        state.settings.socketMode === "allowAll" ||
        (state.settings.socketMode === "kmuxOnly" &&
          Object.values(state.sessions).some(
            (session) => session.authToken === authToken
          ));

      if (!allowed) {
        this.reply(socket, message.id, undefined, {
          code: -32001,
          message: "Socket access denied for current mode"
        });
        return;
      }

      const result = this.route(message.method ?? "", message.params ?? {});
      this.reply(socket, message.id, result);
    } catch (error) {
      this.reply(socket, undefined, undefined, {
        code: -32603,
        message: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  }

  private route(method: string, params: Record<string, unknown>): unknown {
    const state = this.options.getState();
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const activeWorkspace = state.workspaces[activeWorkspaceId];
    const activePane = state.panes[activeWorkspace.activePaneId];
    const activeSurfaceId = activePane.activeSurfaceId;

    switch (method) {
      case "workspace.list":
        return state.windows[state.activeWindowId].workspaceOrder.map(
          (workspaceId) => state.workspaces[workspaceId]
        );
      case "workspace.create":
        this.options.dispatch({
          type: "workspace.create",
          name: params.name as string | undefined,
          cwd: params.cwd as string | undefined
        });
        return { ok: true };
      case "workspace.select":
        this.options.dispatch({
          type: "workspace.select",
          workspaceId: params.workspaceId as string
        });
        return { ok: true };
      case "workspace.current":
        return activeWorkspace;
      case "workspace.close":
        this.options.dispatch({
          type: "workspace.close",
          workspaceId: params.workspaceId as string
        });
        return { ok: true };
      case "surface.list": {
        const workspaceId =
          (params.workspaceId as string | undefined) ?? activeWorkspaceId;
        return Object.values(state.surfaces).filter(
          (surface) => state.panes[surface.paneId].workspaceId === workspaceId
        );
      }
      case "surface.split":
        this.options.dispatch({
          type: "pane.split",
          paneId: params.paneId as string,
          direction: params.direction as SplitDirection
        });
        return { ok: true };
      case "surface.focus":
        this.options.dispatch({
          type: "surface.focus",
          surfaceId: (params.surfaceId as string | undefined) ?? activeSurfaceId
        });
        return { ok: true };
      case "surface.send_text":
        this.options.sendSurfaceText(
          (params.surfaceId as string | undefined) ?? activeSurfaceId,
          params.text as string
        );
        return { ok: true };
      case "surface.send_key":
        this.options.sendSurfaceKey(
          (params.surfaceId as string | undefined) ?? activeSurfaceId,
          params.key as string
        );
        return { ok: true };
      case "notification.create":
        this.options.dispatch({
          type: "notification.create",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId,
          title: params.title as string,
          message: params.message as string,
          surfaceId: params.surfaceId as string | undefined,
          paneId: params.paneId as string | undefined
        });
        return { ok: true };
      case "notification.list":
        return state.notifications;
      case "notification.clear":
        this.options.dispatch({
          type: "notification.clear",
          notificationId: params.notificationId as string | undefined
        });
        return { ok: true };
      case "sidebar.set_status":
        this.options.dispatch({
          type: "sidebar.setStatus",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId,
          text: params.text as string
        });
        return { ok: true };
      case "sidebar.clear_status":
        this.options.dispatch({
          type: "sidebar.clearStatus",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId
        });
        return { ok: true };
      case "sidebar.set_progress":
        this.options.dispatch({
          type: "sidebar.setProgress",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId,
          progress: {
            value: Number(params.value ?? 0),
            label: params.label as string | undefined
          }
        });
        return { ok: true };
      case "sidebar.clear_progress":
        this.options.dispatch({
          type: "sidebar.clearProgress",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId
        });
        return { ok: true };
      case "sidebar.log":
        this.options.dispatch({
          type: "sidebar.log",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId,
          level:
            (params.level as "info" | "warn" | "error" | undefined) ?? "info",
          message: params.message as string
        });
        return { ok: true };
      case "sidebar.clear_log":
        this.options.dispatch({
          type: "sidebar.clearLog",
          workspaceId:
            (params.workspaceId as string | undefined) ?? activeWorkspaceId
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
        throw new Error(`Unknown method: ${method}`);
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
}
