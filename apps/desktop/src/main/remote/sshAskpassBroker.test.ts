import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SshAskpassPrompt } from "@kmux/proto";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSshAskpassBroker,
  type SshAskpassBroker
} from "./sshAskpassBroker";

describe("SSH askpass broker", () => {
  let broker: SshAskpassBroker | undefined;

  afterEach(async () => {
    await broker?.stop();
    broker = undefined;
  });

  it("brokers one bounded in-memory credential through a private context", async () => {
    const prompts: SshAskpassPrompt[] = [];
    broker = createSshAskpassBroker({
      electronPath: process.execPath,
      clientPath: "/tmp/kmux-askpass-client.js",
      publishPrompt: (prompt) => prompts.push(prompt),
      makePromptId: () => "prompt_1"
    });
    await broker.start();
    const context = await broker.createContext(profile());
    const metadata = statSync(context.askpassPath);
    expect(metadata.mode & 0o777).toBe(0o700);
    const helper = readFileSync(context.askpassPath, "utf8");
    const socketPath = exportedValue(helper, "KMUX_SSH_ASKPASS_SOCKET");
    const token = exportedValue(helper, "KMUX_SSH_ASKPASS_TOKEN");
    const contextId = exportedValue(helper, "KMUX_SSH_ASKPASS_CONTEXT");

    const responsePromise = request(socketPath, {
      version: 1,
      token,
      contextId,
      prompt: "Enter passphrase for key '/keys/dev'"
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toMatchObject({
      requestId: "prompt_1",
      profileId: "profile_1",
      profileName: "Development"
    });
    broker.respond({
      requestId: "prompt_1",
      cancelled: false,
      response: "one-time-secret"
    });

    await expect(responsePromise).resolves.toEqual({
      status: "ok",
      response: "one-time-secret"
    });
    expect(readFileSync(context.askpassPath, "utf8")).not.toContain(
      "one-time-secret"
    );
    await context.dispose();
    expect(() => statSync(context.askpassPath)).toThrow();
  });

  it("runs the product askpass client through the generated helper", async () => {
    const compileRoot = mkdtempSync(join(tmpdir(), "kmux-askpass-client-"));
    const clientPath = join(compileRoot, "askpass-client.mjs");
    const clientSource = readFileSync(
      new URL("../../askpass-client/index.ts", import.meta.url),
      "utf8"
    );
    writeFileSync(
      clientPath,
      ts.transpileModule(clientSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022
        }
      }).outputText,
      { mode: 0o600 }
    );
    const prompts: SshAskpassPrompt[] = [];
    let publishPrompt!: (prompt: SshAskpassPrompt) => void;
    const promptPublished = new Promise<SshAskpassPrompt>((resolve) => {
      publishPrompt = resolve;
    });
    try {
      broker = createSshAskpassBroker({
        electronPath: process.execPath,
        clientPath,
        publishPrompt: (prompt) => {
          prompts.push(prompt);
          publishPrompt(prompt);
        },
        makePromptId: () => "prompt_product_client"
      });
      await broker.start();
      const context = await broker.createContext(profile());
      const child = spawn(context.askpassPath, ["Password for kmux:"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      const completed = collectChild(child);

      const firstOutcome = await Promise.race([
        promptPublished.then((prompt) => ({ kind: "prompt" as const, prompt })),
        completed.then((completion) => ({
          kind: "completed" as const,
          completion
        }))
      ]);
      if (firstOutcome.kind === "completed") {
        throw new Error(
          `askpass helper exited before publishing a prompt: ${JSON.stringify(firstOutcome.completion)}`
        );
      }
      expect(prompts).toEqual([firstOutcome.prompt]);
      broker.respond({
        requestId: "prompt_product_client",
        cancelled: false,
        response: "one-time-product-secret"
      });

      await expect(completed).resolves.toEqual({
        code: 0,
        stdout: "one-time-product-secret\n",
        stderr: ""
      });
      await context.dispose();
    } finally {
      rmSync(compileRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("cancels a pending prompt when its authentication context is disposed", async () => {
    let published: SshAskpassPrompt | undefined;
    broker = createSshAskpassBroker({
      electronPath: process.execPath,
      clientPath: "/tmp/kmux-askpass-client.js",
      publishPrompt: (prompt) => {
        published = prompt;
      }
    });
    await broker.start();
    const context = await broker.createContext(profile());
    const helper = readFileSync(context.askpassPath, "utf8");
    const responsePromise = request(
      exportedValue(helper, "KMUX_SSH_ASKPASS_SOCKET"),
      {
        version: 1,
        token: exportedValue(helper, "KMUX_SSH_ASKPASS_TOKEN"),
        contextId: exportedValue(helper, "KMUX_SSH_ASKPASS_CONTEXT"),
        prompt: "Password:"
      }
    );
    await vi.waitFor(() => expect(published).toBeDefined());

    await context.dispose();
    await expect(responsePromise).resolves.toEqual({ status: "cancelled" });
  });

  it("preserves a UTF-8 prompt split across socket chunks", async () => {
    const prompts: SshAskpassPrompt[] = [];
    broker = createSshAskpassBroker({
      electronPath: process.execPath,
      clientPath: "/tmp/kmux-askpass-client.js",
      publishPrompt: (prompt) => prompts.push(prompt),
      makePromptId: () => "prompt_utf8"
    });
    await broker.start();
    const context = await broker.createContext(profile());
    const helper = readFileSync(context.askpassPath, "utf8");
    const body = {
      version: 1,
      token: exportedValue(helper, "KMUX_SSH_ASKPASS_TOKEN"),
      contextId: exportedValue(helper, "KMUX_SSH_ASKPASS_CONTEXT"),
      prompt: "개발 키 암호 €:"
    };
    const encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    const euroOffset = encoded.indexOf(Buffer.from("€", "utf8"));
    const responsePromise = request(
      exportedValue(helper, "KMUX_SSH_ASKPASS_SOCKET"),
      body,
      euroOffset + 1
    );

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]?.prompt).toBe("개발 키 암호 €:");
    broker.respond({ requestId: "prompt_utf8", cancelled: true });
    await expect(responsePromise).resolves.toEqual({ status: "cancelled" });
    await context.dispose();
  });

  it("fails a colliding prompt ID without replacing the pending credential request", async () => {
    const prompts: SshAskpassPrompt[] = [];
    broker = createSshAskpassBroker({
      electronPath: process.execPath,
      clientPath: "/tmp/kmux-askpass-client.js",
      publishPrompt: (prompt) => prompts.push(prompt),
      makePromptId: () => "prompt_collision"
    });
    await broker.start();
    const context = await broker.createContext(profile());
    const helper = readFileSync(context.askpassPath, "utf8");
    const socketPath = exportedValue(helper, "KMUX_SSH_ASKPASS_SOCKET");
    const requestBody = {
      version: 1,
      token: exportedValue(helper, "KMUX_SSH_ASKPASS_TOKEN"),
      contextId: exportedValue(helper, "KMUX_SSH_ASKPASS_CONTEXT"),
      prompt: "Password:"
    };

    const first = request(socketPath, requestBody);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const collision = request(socketPath, requestBody);
    await expect(collision).resolves.toEqual({ status: "cancelled" });
    expect(prompts).toHaveLength(1);

    broker.respond({
      requestId: "prompt_collision",
      cancelled: false,
      response: "first-secret"
    });
    await expect(first).resolves.toEqual({
      status: "ok",
      response: "first-secret"
    });
  });

  it("rejects malformed renderer responses before releasing a prompt", async () => {
    broker = createSshAskpassBroker({
      electronPath: process.execPath,
      clientPath: "/tmp/kmux-askpass-client.js",
      publishPrompt: () => undefined
    });
    await broker.start();
    expect(() =>
      broker!.respond({
        requestId: "prompt_1",
        cancelled: true,
        response: "must-not-be-present"
      })
    ).toThrow(/cannot contain a secret/u);
  });

  it("closes an idle client without waiting for the prompt timeout", async () => {
    broker = createSshAskpassBroker({
      electronPath: process.execPath,
      clientPath: "/tmp/kmux-askpass-client.js",
      publishPrompt: () => undefined
    });
    await broker.start();
    const context = await broker.createContext(profile());
    const helper = readFileSync(context.askpassPath, "utf8");
    const socket = createConnection(
      exportedValue(helper, "KMUX_SSH_ASKPASS_SOCKET")
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve)
    );
    await broker.stop();
    await closed;
    broker = undefined;
  });
});

function profile() {
  return {
    id: "profile_1",
    name: "Development",
    host: "dev.example.com",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function exportedValue(script: string, name: string): string {
  const match = script.match(new RegExp(`^export ${name}='([^']+)'$`, "mu"));
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

function collectChild(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function request(
  socketPath: string,
  body: Record<string, unknown>,
  splitAfterBytes?: number
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.once("connect", () => {
      const encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
      if (
        splitAfterBytes === undefined ||
        splitAfterBytes <= 0 ||
        splitAfterBytes >= encoded.byteLength
      ) {
        socket.write(encoded);
        return;
      }
      socket.write(encoded.subarray(0, splitAfterBytes));
      setImmediate(() => socket.write(encoded.subarray(splitAfterBytes)));
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}
