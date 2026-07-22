import { createConnection, createServer, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

import {
  encodeAppStateDto,
  type AppAction,
  type AppState,
  listWorkspaceSurfaceIds,
  terminalSessionForSurface
} from "@kmux/core";
import type {
  JsonRpcEnvelope,
  ShellIdentity,
  SplitDirection
} from "@kmux/proto";
import {
  makeId,
  normalizeAgentHookInvocation,
  normalizeHookNotificationInvocation
} from "@kmux/proto";
import { ZodError } from "zod";

import { formatLocalLogTimestamp } from "../shared/diagnostics";
import {
  type ParsedSocketRequest,
  parseSocketEnvelope,
  parseSocketRequest,
  UnknownSocketMethodError
} from "./socketRpc";

type AgentEventParams = Extract<
  ParsedSocketRequest,
  { method: "agent.event" }
>["params"];
type SurfaceScopedPaneParams = {
  paneId?: string;
  surfaceId?: string;
  sessionId?: string;
};

const RECENT_STRUCTURED_AGENT_DEDUPE_MS = 5 * 60 * 1000;
const POSIX_SOCKET_PATH_MAX_BYTES = 103;
const SOCKET_PROBE_TIMEOUT_MS = 300;

export type SocketStartupFailureReason =
  | "socket-path-too-long"
  | "unsafe-runtime-directory"
  | "socket-path-not-socket"
  | "live-owner"
  | "bind-failure";

export class SocketStartupError extends Error {
  constructor(
    readonly reason: SocketStartupFailureReason,
    readonly socketPath: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "SocketStartupError";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errnoCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

function validateSocketPathLength(socketPath: string): void {
  const byteLength = Buffer.byteLength(socketPath, "utf8");
  if (byteLength <= POSIX_SOCKET_PATH_MAX_BYTES) {
    return;
  }
  throw new SocketStartupError(
    "socket-path-too-long",
    socketPath,
    `Unix socket path is too long (${byteLength} bytes): ${socketPath}`
  );
}

export function ensureSocketRuntimeDirectory(socketPath: string): void {
  const runtimeDir = dirname(socketPath);
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SocketStartupError(
      "unsafe-runtime-directory",
      socketPath,
      `Unable to create socket runtime directory ${runtimeDir}`,
      error
    );
  }

  let runtimeStats;
  try {
    runtimeStats = lstatSync(runtimeDir);
  } catch (error) {
    throw new SocketStartupError(
      "unsafe-runtime-directory",
      socketPath,
      `Unable to inspect socket runtime directory ${runtimeDir}`,
      error
    );
  }
  if (runtimeStats.isSymbolicLink() || !runtimeStats.isDirectory()) {
    throw new SocketStartupError(
      "unsafe-runtime-directory",
      socketPath,
      `Socket runtime path is not a real directory: ${runtimeDir}`
    );
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && runtimeStats.uid !== getuid()) {
    throw new SocketStartupError(
      "unsafe-runtime-directory",
      socketPath,
      `Socket runtime directory is owned by uid ${runtimeStats.uid}, expected ${getuid()}: ${runtimeDir}`
    );
  }

  try {
    chmodSync(runtimeDir, 0o700);
  } catch (error) {
    throw new SocketStartupError(
      "unsafe-runtime-directory",
      socketPath,
      `Unable to make socket runtime directory private: ${runtimeDir}`,
      error
    );
  }

  const mode = statSync(runtimeDir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SocketStartupError(
      "unsafe-runtime-directory",
      socketPath,
      `Socket runtime directory is not private: ${runtimeDir}`
    );
  }
}

function assertExistingSocketPathIsSafe(
  socketPath: string
): "missing" | "socket" {
  try {
    const socketStats = lstatSync(socketPath);
    if (socketStats.isSocket()) {
      return "socket";
    }
    throw new SocketStartupError(
      "socket-path-not-socket",
      socketPath,
      `Refusing to replace non-socket path: ${socketPath}`
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return "missing";
    }
    if (error instanceof SocketStartupError) {
      throw error;
    }
    throw new SocketStartupError(
      "bind-failure",
      socketPath,
      `Unable to inspect socket path: ${socketPath}`,
      error
    );
  }
}

type SocketProbeResult = "missing" | "live" | "stale";

export function probeExistingSocket(
  socketPath: string,
  timeoutMs = SOCKET_PROBE_TIMEOUT_MS
): Promise<SocketProbeResult> {
  const pathState = assertExistingSocketPathIsSafe(socketPath);
  if (pathState === "missing") {
    return Promise.resolve("missing");
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: SocketProbeResult, error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const timeout = setTimeout(() => {
      finish(
        "stale",
        new SocketStartupError(
          "live-owner",
          socketPath,
          `Timed out probing existing kmux socket: ${socketPath}`
        )
      );
    }, timeoutMs);

    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => {
      const code = errnoCode(error);
      if (code === "ENOENT") {
        finish("missing");
        return;
      }
      if (code === "ECONNREFUSED" || code === "ECONNRESET") {
        finish("stale");
        return;
      }
      finish(
        "stale",
        new SocketStartupError(
          "bind-failure",
          socketPath,
          `Unable to probe existing socket: ${socketPath}`,
          error
        )
      );
    });
  });
}

export async function prepareSocketPathForListen(
  socketPath: string
): Promise<void> {
  validateSocketPathLength(socketPath);
  ensureSocketRuntimeDirectory(socketPath);
  const probeResult = await probeExistingSocket(socketPath);
  if (probeResult === "live") {
    throw new SocketStartupError(
      "live-owner",
      socketPath,
      `Another kmux instance is already listening on ${socketPath}`
    );
  }
  if (probeResult === "stale") {
    rmSync(socketPath, { force: true });
  }
}

function hasRecentStructuredAgentNotification(
  state: AppState,
  agent: string,
  surfaceId: string
): boolean {
  const cutoff = Date.now() - RECENT_STRUCTURED_AGENT_DEDUPE_MS;
  return state.notifications.some(
    (notification) =>
      (notification.kind === "turn_complete" ||
        notification.kind === "needs_input") &&
      notification.agent === agent &&
      notification.surfaceId === surfaceId &&
      Date.parse(notification.createdAt) >= cutoff
  );
}

function isIgnorableSocketReplyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "";

  return (
    code === "EPIPE" ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_DESTROYED" ||
    message.includes("write EPIPE") ||
    message.includes("stream is destroyed")
  );
}

function isReplySocketWritable(socket: Socket): boolean {
  return !socket.destroyed && socket.writable && !socket.writableEnded;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function mapTerminalControlResult(value: unknown): unknown {
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then((resolved) => resolved ?? { ok: true });
  }
  return value ?? { ok: true };
}

function resolveLivePaneIdForStableTarget(
  state: AppState,
  params: SurfaceScopedPaneParams,
  authToken?: string
): string | undefined {
  const authSurfaceId = authToken
    ? Object.values(state.sessions).find(
        (session) => session.authToken === authToken
      )?.surfaceId
    : undefined;
  const candidateSurfaceIds = [
    params.surfaceId,
    params.sessionId ? state.sessions[params.sessionId]?.surfaceId : undefined,
    authSurfaceId
  ];

  for (const surfaceId of candidateSurfaceIds) {
    const surface = surfaceId ? state.surfaces[surfaceId] : undefined;
    if (surface && state.panes[surface.paneId]) {
      return surface.paneId;
    }
  }

  return undefined;
}

interface SocketServerOptions {
  socketPath: string;
  getState?: () => AppState;
  dispatch?: (action: AppAction) => void;
  sendSurfaceText?: (
    surfaceId: string,
    text: string,
    operationId?: string
  ) => unknown | Promise<unknown>;
  sendSurfaceKey?: (
    surfaceId: string,
    key: string,
    operationId?: string
  ) => unknown | Promise<unknown>;
  captureSurface?: (request: {
    surfaceId: string;
    captureId?: string;
    lines: number;
    maxBytes: number;
  }) => unknown | Promise<unknown>;
  identify?: () => ShellIdentity;
  isSurfaceVisibleToUser?: (surfaceId: string) => boolean;
  onAgentHook?: (hook: {
    agent: string;
    hookEvent: string;
    payload: Record<string, unknown>;
  }) => void;
}

interface SocketServerRuntime {
  getState: () => AppState;
  dispatch: (action: AppAction) => void;
  sendSurfaceText: (
    surfaceId: string,
    text: string,
    operationId?: string
  ) => unknown | Promise<unknown>;
  sendSurfaceKey: (
    surfaceId: string,
    key: string,
    operationId?: string
  ) => unknown | Promise<unknown>;
  captureSurface?: (request: {
    surfaceId: string;
    captureId?: string;
    lines: number;
    maxBytes: number;
  }) => unknown | Promise<unknown>;
  identify: () => ShellIdentity;
  isSurfaceVisibleToUser?: (surfaceId: string) => boolean;
  onAgentHook?: (hook: {
    agent: string;
    hookEvent: string;
    payload: Record<string, unknown>;
  }) => void;
}

class SocketServerStartingError extends Error {
  constructor() {
    super("kmux socket server is still starting");
    this.name = "SocketServerStartingError";
  }
}

function extractRuntime(
  options: SocketServerOptions
): SocketServerRuntime | null {
  if (
    !options.getState ||
    !options.dispatch ||
    !options.sendSurfaceText ||
    !options.sendSurfaceKey ||
    !options.identify
  ) {
    return null;
  }

  return {
    getState: options.getState,
    dispatch: options.dispatch,
    sendSurfaceText: options.sendSurfaceText,
    sendSurfaceKey: options.sendSurfaceKey,
    captureSurface: options.captureSurface,
    identify: options.identify,
    isSurfaceVisibleToUser: options.isSurfaceVisibleToUser,
    onAgentHook: options.onAgentHook
  };
}

export class KmuxSocketServer {
  private readonly server;
  private runtime: SocketServerRuntime | null;

  constructor(private readonly options: SocketServerOptions) {
    this.runtime = extractRuntime(options);
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  setRuntime(runtime: SocketServerRuntime): void {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    await prepareSocketPathForListen(this.options.socketPath);
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        reject(
          new SocketStartupError(
            "bind-failure",
            this.options.socketPath,
            `Unable to listen on kmux socket ${this.options.socketPath}`,
            error
          )
        );
      };
      this.server.once("error", onError);
      this.server.listen(this.options.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    socket.on("error", (error) => {
      if (isIgnorableSocketReplyError(error)) {
        return;
      }
      console.warn("[socket-server]", error);
    });
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
      const runtime = this.getRuntime();
      const state = runtime.getState();
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
      const result = this.route(request, runtime);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          (resolved) => this.reply(socket, request.id, resolved),
          (error: unknown) =>
            this.reply(socket, request.id, undefined, {
              code: -32603,
              message:
                error instanceof Error ? error.message : "Unknown server error"
            })
        );
      } else {
        this.reply(socket, request.id, result);
      }
    } catch (error) {
      if (error instanceof SocketServerStartingError) {
        this.reply(socket, envelope?.id, undefined, {
          code: -32002,
          message: error.message
        });
        return;
      }
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

  private getRuntime(): SocketServerRuntime {
    if (!this.runtime) {
      throw new SocketServerStartingError();
    }
    return this.runtime;
  }

  private route(
    request: ParsedSocketRequest,
    runtime: SocketServerRuntime
  ): unknown {
    const state = runtime.getState();
    const activeWorkspaceId =
      state.windows[state.activeWindowId].activeWorkspaceId;
    const activeWorkspace = state.workspaces[activeWorkspaceId];
    const activePane = state.panes[activeWorkspace.activePaneId];
    const activeSurfaceId = activePane.activeSurfaceId;

    switch (request.method) {
      case "workspace.list":
        return encodeWorkspaceSocketDtos(
          state,
          state.windows[state.activeWindowId].workspaceOrder
        );
      case "workspace.create":
        runtime.dispatch({
          type: "workspace.create",
          name: request.params.name,
          cwd: request.params.cwd
        });
        return { ok: true };
      case "workspace.select":
        runtime.dispatch({
          type: "workspace.select",
          workspaceId: request.params.workspaceId
        });
        return { ok: true };
      case "workspace.current":
        return encodeWorkspaceSocketDtos(state, [activeWorkspaceId])[0];
      case "workspace.close":
        runtime.dispatch({
          type: "workspace.close",
          workspaceId: request.params.workspaceId
        });
        return { ok: true };
      case "surface.list": {
        const workspaceId = request.params.workspaceId ?? activeWorkspaceId;
        return encodeSurfaceSocketDtos(
          state,
          listWorkspaceSurfaceIds(state, workspaceId)
        );
      }
      case "surface.split":
        runtime.dispatch({
          type: "pane.split",
          paneId:
            resolveLivePaneIdForStableTarget(
              state,
              request.params,
              request.authToken
            ) ??
            request.params.paneId ??
            activePane.id,
          direction: request.params.direction as SplitDirection
        });
        return { ok: true };
      case "surface.focus":
        runtime.dispatch({
          type: "surface.focus",
          surfaceId: request.params.surfaceId ?? activeSurfaceId
        });
        return { ok: true };
      case "surface.send_text":
        return mapTerminalControlResult(runtime.sendSurfaceText(
          request.params.surfaceId ?? activeSurfaceId,
          request.params.text,
          request.params.operationId
        ));
      case "surface.send_key":
        return mapTerminalControlResult(runtime.sendSurfaceKey(
          request.params.surfaceId ?? activeSurfaceId,
          request.params.key,
          request.params.operationId
        ));
      case "surface.capture": {
        if (!runtime.captureSurface) {
          throw new Error("surface capture is unavailable");
        }
        return runtime.captureSurface({
          surfaceId: request.params.surfaceId ?? activeSurfaceId,
          captureId: request.params.captureId,
          lines: request.params.lines,
          maxBytes: request.params.maxBytes
        });
      }
      case "notification.create":
        runtime.dispatch({
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
        runtime.dispatch({
          type: "notification.clear",
          notificationId: request.params.notificationId
        });
        return { ok: true };
      case "sidebar.set_status":
        runtime.dispatch({
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
        runtime.dispatch({
          type: "sidebar.clearStatus",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          key: request.params.key
        });
        return { ok: true };
      case "agent.event":
        return this.dispatchAgentEvent(
          request.params,
          activeWorkspaceId,
          runtime
        );
      case "agent.hook": {
        const onAgentHook = runtime.onAgentHook;
        if (onAgentHook) {
          setImmediate(() => {
            try {
              onAgentHook({
                agent: request.params.agent,
                hookEvent: request.params.hookEvent,
                payload: request.params.payload ?? {}
              });
            } catch {
              // Hook side effects must not block the agent hook response path.
            }
          });
        }
        const event = normalizeAgentHookInvocation(
          request.params.agent,
          request.params.hookEvent,
          request.params.payload ?? {},
          {
            KMUX_WORKSPACE_ID: request.params.workspaceId,
            KMUX_SURFACE_ID: request.params.surfaceId,
            KMUX_SESSION_ID: request.params.sessionId
          }
        );
        if (event) {
          return this.dispatchAgentEvent(
            event.paneId || !request.params.paneId
              ? event
              : { ...event, paneId: request.params.paneId },
            activeWorkspaceId,
            runtime
          );
        }
        const notification = normalizeHookNotificationInvocation(
          request.params.agent,
          request.params.hookEvent,
          request.params.payload ?? {},
          {
            KMUX_WORKSPACE_ID: request.params.workspaceId,
            KMUX_SURFACE_ID: request.params.surfaceId,
            KMUX_SESSION_ID: request.params.sessionId
          }
        );
        if (notification) {
          return this.dispatchHookNotification(
            notification.paneId || !request.params.paneId
              ? notification
              : { ...notification, paneId: request.params.paneId },
            activeWorkspaceId,
            runtime
          );
        }
        return { ok: true, handled: false };
      }
      case "sidebar.set_progress":
        runtime.dispatch({
          type: "sidebar.setProgress",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          progress: {
            value: request.params.value,
            label: request.params.label
          }
        });
        return { ok: true };
      case "sidebar.clear_progress":
        runtime.dispatch({
          type: "sidebar.clearProgress",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId
        });
        return { ok: true };
      case "sidebar.log":
        runtime.dispatch({
          type: "sidebar.log",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId,
          level: request.params.level ?? "info",
          message: request.params.message
        });
        return { ok: true };
      case "sidebar.clear_log":
        runtime.dispatch({
          type: "sidebar.clearLog",
          workspaceId: request.params.workspaceId ?? activeWorkspaceId
        });
        return { ok: true };
      case "sidebar.state":
      case "sidebar_state":
        return encodeWorkspaceSocketDtos(state, [activeWorkspaceId])[0];
      case "system.ping":
        return { pong: true, id: makeId("pong") };
      case "system.capabilities":
        return runtime.identify().capabilities;
      case "system.identify":
        return runtime.identify();
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
    if (!isReplySocketWritable(socket)) {
      return;
    }
    const payload = `${JSON.stringify(response)}\n`;
    try {
      socket.write(payload);
    } catch (writeError) {
      if (isIgnorableSocketReplyError(writeError)) {
        return;
      }
      throw writeError;
    }
  }

  private dispatchAgentEvent(
    params: AgentEventParams,
    fallbackWorkspaceId: string,
    runtime: SocketServerRuntime
  ): { ok: true } {
    logAgentEvent(params, fallbackWorkspaceId);
    const state = runtime.getState();
    const surfaceId =
      params.surfaceId ??
      (params.sessionId
        ? state.sessions[params.sessionId]?.surfaceId
        : undefined);
    const details = {
      ...(params.details ?? {}),
      ...(surfaceId && runtime.isSurfaceVisibleToUser?.(surfaceId)
        ? { visibleToUser: true }
        : {})
    };
    runtime.dispatch({
      type: "agent.event",
      workspaceId: params.workspaceId ?? fallbackWorkspaceId,
      paneId: params.paneId
        ? (resolveLivePaneIdForStableTarget(state, params) ?? params.paneId)
        : undefined,
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

  private dispatchHookNotification(
    params: ReturnType<
      typeof normalizeHookNotificationInvocation
    > extends infer TResult
      ? Exclude<TResult, null>
      : never,
    fallbackWorkspaceId: string,
    runtime: SocketServerRuntime
  ): { ok: true } {
    const state = runtime.getState();
    const surfaceId =
      params.surfaceId ??
      (params.sessionId
        ? state.sessions[params.sessionId]?.surfaceId
        : undefined);
    if (surfaceId && runtime.isSurfaceVisibleToUser?.(surfaceId)) {
      return { ok: true };
    }
    if (
      surfaceId &&
      hasRecentStructuredAgentNotification(state, params.agent, surfaceId)
    ) {
      return { ok: true };
    }
    const paneId =
      resolveLivePaneIdForStableTarget(state, params) ?? params.paneId;
    runtime.dispatch({
      type: "notification.create",
      workspaceId: params.workspaceId ?? fallbackWorkspaceId,
      paneId,
      surfaceId,
      title: params.title,
      message: params.message,
      source: params.source,
      agent: params.agent
    });
    return { ok: true };
  }
}

function encodeWorkspaceSocketDtos(
  state: AppState,
  workspaceIds: string[]
): unknown[] {
  const snapshot = encodeAppStateDto(state);
  const workspaces = readDtoRecord(snapshot.workspaces);
  return workspaceIds.flatMap((workspaceId) =>
    workspaces[workspaceId] === undefined ? [] : [workspaces[workspaceId]]
  );
}

function encodeSurfaceSocketDtos(
  state: AppState,
  surfaceIds: string[]
): unknown[] {
  const snapshot = encodeAppStateDto(state);
  const surfaces = readDtoRecord(snapshot.surfaces);
  const sessions = readDtoRecord(snapshot.sessions);
  return surfaceIds.flatMap((surfaceId) => {
    const surface = surfaces[surfaceId];
    if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
      return [];
    }
    const session = terminalSessionForSurface(state, surfaceId);
    const sessionDto = session
      ? readDtoRecord(sessions[session.id])
      : undefined;
    const runtimeMetadata = sessionDto
      ? readDtoRecord(sessionDto.runtimeMetadata)
      : undefined;
    return [
      {
        ...surface,
        ...(session
          ? {
              sessionId: session.id,
              ...runtimeMetadata
            }
          : {})
      }
    ];
  });
}

function readDtoRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  console.log(`${formatLocalLogTimestamp()} [Agent Hook] ${fields.join(" ")}`);
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
