import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type {
  SshAskpassPrompt,
  SshAskpassResponseRequest,
  SshProfileDto
} from "@kmux/proto";
import { makeId } from "@kmux/proto";

const MAX_CONTEXTS = 32;
const MAX_PENDING_PROMPTS = 16;
const MAX_REQUEST_BYTES = 16 * 1024;
const PROMPT_TIMEOUT_MS = 2 * 60_000;

export interface SshAskpassContext {
  askpassPath: string;
  dispose(): Promise<void>;
}

export interface SshAskpassBroker {
  start(): Promise<void>;
  stop(): Promise<void>;
  createContext(profile: SshProfileDto): Promise<SshAskpassContext>;
  respond(request: SshAskpassResponseRequest): void;
}

export function createSshAskpassBroker(options: {
  electronPath: string;
  clientPath: string;
  publishPrompt: (prompt: SshAskpassPrompt) => void;
  makePromptId?: () => string;
}): SshAskpassBroker {
  assertAbsoluteProgramPath(options.electronPath, "Electron executable");
  assertAbsoluteProgramPath(options.clientPath, "askpass client");
  const makePromptId = options.makePromptId ?? (() => makeId("ssh-askpass"));
  const root = mkdtempSync(join(shortTemporaryRoot(), "kma-"));
  chmodSync(root, 0o700);
  const socketPath = join(root, "broker.sock");
  const token = randomBytes(32).toString("hex");
  const contexts = new Map<string, Context>();
  const pending = new Map<string, PendingPrompt>();
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let stopped = false;

  const cancelContext = (contextId: string): void => {
    const context = contexts.get(contextId);
    if (!context) return;
    contexts.delete(contextId);
    for (const [requestId, prompt] of pending) {
      if (prompt.contextId !== contextId) continue;
      pending.delete(requestId);
      clearTimeout(prompt.timeout);
      prompt.resolve(null);
    }
    safelyUnlink(context.askpassPath);
  };

  return Object.freeze({
    async start(): Promise<void> {
      if (stopped) throw new Error("SSH askpass broker has stopped");
      if (server) return;
      const next = createServer((socket) => handleSocket(socket));
      next.maxConnections = MAX_CONTEXTS;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          next.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          next.off("error", onError);
          resolve();
        };
        next.once("error", onError);
        next.once("listening", onListening);
        next.listen(socketPath);
      });
      chmodSync(socketPath, 0o600);
      server = next;
    },

    async createContext(profile: SshProfileDto): Promise<SshAskpassContext> {
      if (stopped || !server) {
        throw new Error("SSH askpass broker is unavailable");
      }
      if (contexts.size >= MAX_CONTEXTS) {
        throw new Error("too many SSH authentication contexts are active");
      }
      const contextId = randomBytes(24).toString("hex");
      const askpassPath = join(root, `askpass-${contextId}`);
      const script = [
        "#!/bin/sh",
        "set -f",
        "umask 077",
        `export ELECTRON_RUN_AS_NODE=1`,
        `export KMUX_SSH_ASKPASS_SOCKET=${quotePosixWord(socketPath)}`,
        `export KMUX_SSH_ASKPASS_TOKEN=${quotePosixWord(token)}`,
        `export KMUX_SSH_ASKPASS_CONTEXT=${quotePosixWord(contextId)}`,
        `exec ${quotePosixWord(options.electronPath)} ${quotePosixWord(options.clientPath)} "$@"`,
        ""
      ].join("\n");
      const descriptor = openSync(
        askpassPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o700
      );
      try {
        writeFileSync(descriptor, script, "utf8");
      } finally {
        closeSync(descriptor);
      }
      const metadata = lstatSync(askpassPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          metadata.uid !== process.getuid())
      ) {
        safelyUnlink(askpassPath);
        throw new Error("SSH askpass helper is not a private regular file");
      }
      const context: Context = {
        contextId,
        profileId: profile.id,
        profileName: profile.name,
        askpassPath
      };
      contexts.set(contextId, context);
      let disposed = false;
      return Object.freeze({
        askpassPath,
        async dispose(): Promise<void> {
          if (disposed) return;
          disposed = true;
          cancelContext(contextId);
        }
      });
    },

    respond(value: SshAskpassResponseRequest): void {
      const request = decodeResponse(value);
      const prompt = pending.get(request.requestId);
      if (!prompt) return;
      pending.delete(request.requestId);
      clearTimeout(prompt.timeout);
      prompt.resolve(request.cancelled ? null : (request.response ?? null));
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const contextId of [...contexts.keys()]) cancelContext(contextId);
      for (const [requestId, prompt] of pending) {
        pending.delete(requestId);
        clearTimeout(prompt.timeout);
        prompt.resolve(null);
      }
      const current = server;
      server = null;
      if (current) {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  function handleSocket(socket: Socket): void {
    if (stopped) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(PROMPT_TIMEOUT_MS, () => socket.destroy());
    let bytes = 0;
    let payload = "";
    let handled = false;
    const decoder = new StringDecoder("utf8");
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      payload += decoder.write(chunk);
      if (!payload.includes("\n")) return;
      handled = true;
      void respondToSocket(socket, payload.slice(0, payload.indexOf("\n")));
    });
    socket.once("error", () => undefined);
  }

  async function respondToSocket(
    socket: Socket,
    payload: string
  ): Promise<void> {
    let response: string | null = null;
    try {
      const request = decodeClientRequest(payload, token);
      const context = contexts.get(request.contextId);
      if (!context || pending.size >= MAX_PENDING_PROMPTS) {
        throw new Error("SSH authentication context is unavailable");
      }
      const requestId = requireId(makePromptId(), "askpass requestId");
      if (pending.has(requestId)) {
        throw new Error("SSH askpass request ID is already pending");
      }
      response = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          resolve(null);
        }, PROMPT_TIMEOUT_MS);
        timeout.unref();
        pending.set(requestId, {
          contextId: context.contextId,
          resolve,
          timeout
        });
        try {
          options.publishPrompt({
            requestId,
            profileId: context.profileId,
            profileName: context.profileName,
            prompt: request.prompt
          });
        } catch {
          pending.delete(requestId);
          clearTimeout(timeout);
          resolve(null);
        }
      });
    } catch {
      response = null;
    }
    if (!socket.destroyed) {
      socket.end(
        `${JSON.stringify(
          response === null
            ? { status: "cancelled" }
            : { status: "ok", response }
        )}\n`
      );
    }
  }
}

interface Context {
  contextId: string;
  profileId: string;
  profileName: string;
  askpassPath: string;
}

interface PendingPrompt {
  contextId: string;
  resolve: (response: string | null) => void;
  timeout: NodeJS.Timeout;
}

function decodeClientRequest(
  payload: string,
  expectedToken: string
): { contextId: string; prompt: string } {
  const value = JSON.parse(payload) as unknown;
  const record = requireRecord(value, "askpass client request");
  assertExactKeys(record, ["version", "token", "contextId", "prompt"]);
  if (record.version !== 1 || typeof record.token !== "string") {
    throw new TypeError("askpass client protocol is invalid");
  }
  const actual = Buffer.from(record.token);
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("askpass client is unauthorized");
  }
  return {
    contextId: requireId(record.contextId, "askpass contextId"),
    prompt: requireSingleLine(record.prompt, "askpass prompt", 4_096)
  };
}

function decodeResponse(value: unknown): SshAskpassResponseRequest {
  const record = requireRecord(value, "askpass response");
  assertExactKeys(record, ["requestId", "cancelled", "response"]);
  if (typeof record.cancelled !== "boolean") {
    throw new TypeError("askpass cancellation flag is invalid");
  }
  if (record.cancelled && record.response !== undefined) {
    throw new TypeError("cancelled askpass response cannot contain a secret");
  }
  if (!record.cancelled && record.response === undefined) {
    throw new TypeError("askpass response is missing");
  }
  return {
    requestId: requireId(record.requestId, "askpass requestId"),
    cancelled: record.cancelled,
    ...(record.response === undefined
      ? {}
      : {
          response: requireSingleLine(
            record.response,
            "askpass response",
            4_096
          )
        })
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected)
    throw new TypeError(`unexpected askpass field: ${unexpected}`);
}

function requireId(value: unknown, field: string): string {
  return requireSingleLine(value, field, 256);
}

function requireSingleLine(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function quotePosixWord(value: string): string {
  if (!value || /\0/u.test(value)) throw new TypeError("invalid shell word");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertAbsoluteProgramPath(value: string, field: string): void {
  if (!isAbsolute(value) || value.length > 4_096 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${field} path is invalid`);
  }
}

function safelyUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Context cancellation still resolves prompts even if best-effort
    // ephemeral helper cleanup encounters an external filesystem failure.
  }
}

function shortTemporaryRoot(): string {
  return existsSync("/tmp") ? "/tmp" : tmpdir();
}
