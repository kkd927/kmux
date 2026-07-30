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

export type SshAskpassPurpose = SshAskpassPrompt["purpose"];

export interface SshAskpassContext {
  askpassPath: string;
  wasCancelled(): boolean;
  dispose(): Promise<void>;
}

export interface SshAskpassBroker {
  start(): Promise<void>;
  stop(): Promise<void>;
  createContext(
    profile: SshProfileDto,
    purpose: SshAskpassPurpose
  ): Promise<SshAskpassContext>;
  claimPresenter(presenterId: number): SshAskpassPrompt[];
  releasePresenter(presenterId: number): void;
  respond(request: SshAskpassResponseRequest): void;
}

export function createSshAskpassBroker(options: {
  electronPath: string;
  clientPath: string;
  publishPrompt: (presenterId: number, prompt: SshAskpassPrompt) => void;
  publishResolution?: (presenterId: number, requestId: string) => void;
  makePromptId?: () => string;
  promptTimeoutMs?: number;
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
  const promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
  let server: Server | null = null;
  let presenterId: number | null = null;
  let stopped = false;

  const settlePrompt = (requestId: string, response: string | null): void => {
    const prompt = pending.get(requestId);
    if (!prompt) return;
    pending.delete(requestId);
    clearTimeout(prompt.timeout);
    prompt.resolve(response);
    if (presenterId !== null) {
      try {
        options.publishResolution?.(presenterId, requestId);
      } catch {
        // A replacement renderer will receive only still-pending prompts in
        // its claim snapshot, so resolution delivery is best effort.
      }
    }
  };

  const cancelContext = (contextId: string, cancelled = false): void => {
    const context = contexts.get(contextId);
    if (!context) return;
    if (cancelled) context.cancelled = true;
    contexts.delete(contextId);
    for (const [requestId, prompt] of pending) {
      if (prompt.contextId !== contextId) continue;
      settlePrompt(requestId, null);
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

    async createContext(
      profile: SshProfileDto,
      purpose: SshAskpassPurpose
    ): Promise<SshAskpassContext> {
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
        askpassPath,
        purpose,
        cancelled: false
      };
      contexts.set(contextId, context);
      let disposed = false;
      return Object.freeze({
        askpassPath,
        wasCancelled(): boolean {
          return context.cancelled;
        },
        async dispose(): Promise<void> {
          if (disposed) return;
          disposed = true;
          cancelContext(contextId);
        }
      });
    },

    claimPresenter(nextPresenterId: number): SshAskpassPrompt[] {
      if (
        !Number.isSafeInteger(nextPresenterId) ||
        nextPresenterId <= 0 ||
        stopped
      ) {
        return [];
      }
      if (presenterId !== null && presenterId !== nextPresenterId) {
        return [];
      }
      presenterId = nextPresenterId;
      return [...pending.values()].map((entry) =>
        structuredClone(entry.prompt)
      );
    },

    releasePresenter(currentPresenterId: number): void {
      if (presenterId === currentPresenterId) presenterId = null;
    },

    respond(value: SshAskpassResponseRequest): void {
      const request = decodeResponse(value);
      const prompt = pending.get(request.requestId);
      if (!prompt) return;
      settlePrompt(
        request.requestId,
        request.cancelled ? null : (request.response ?? null)
      );
      if (request.cancelled) cancelContext(prompt.contextId, true);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      presenterId = null;
      for (const contextId of [...contexts.keys()]) cancelContext(contextId);
      for (const requestId of [...pending.keys()])
        settlePrompt(requestId, null);
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
    socket.setTimeout(promptTimeoutMs + 1_000, () => socket.destroy());
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
          settlePrompt(requestId, null);
        }, promptTimeoutMs);
        timeout.unref();
        const published: SshAskpassPrompt = {
          requestId,
          profileId: context.profileId,
          profileName: context.profileName,
          prompt: request.prompt,
          purpose: context.purpose
        };
        pending.set(requestId, {
          contextId: context.contextId,
          prompt: published,
          resolve,
          timeout
        });
        if (presenterId !== null) {
          try {
            options.publishPrompt(presenterId, published);
          } catch {
            // The prompt remains Main-owned and is replayed when a renderer
            // claims presentation after a reload or window replacement.
          }
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
  purpose: SshAskpassPurpose;
  cancelled: boolean;
}

interface PendingPrompt {
  contextId: string;
  prompt: SshAskpassPrompt;
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
    prompt: requirePrompt(record.prompt)
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

function requirePrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("askpass prompt is invalid");
  }
  const normalized = value.replace(/\r\n?/gu, "\n");
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 4_096 ||
    containsDisallowedPromptControl(normalized)
  ) {
    throw new TypeError("askpass prompt is invalid");
  }
  return normalized;
}

function containsDisallowedPromptControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x09 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
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
