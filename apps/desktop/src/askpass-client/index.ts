import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 2 * 60_000;

const socketPath = requireEnvironment("KMUX_SSH_ASKPASS_SOCKET", 4_096);
const token = requireEnvironment("KMUX_SSH_ASKPASS_TOKEN", 256);
const contextId = requireEnvironment("KMUX_SSH_ASKPASS_CONTEXT", 256);
const prompt = process.argv[2] ?? "SSH authentication";

if (Buffer.byteLength(prompt, "utf8") > 4_096 || /[\0\r\n]/u.test(prompt)) {
  process.exitCode = 1;
} else {
  requestCredential().then(
    (credential) => {
      if (credential === null) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${credential}\n`);
    },
    () => {
      process.exitCode = 1;
    }
  );
}

async function requestCredential(): Promise<string | null> {
  return await new Promise<string | null>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let bytes = 0;
    let payload = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("askpass broker timed out"));
    }, REQUEST_TIMEOUT_MS);
    timeout.unref();

    const finish = (error: Error | null, value: string | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ version: 1, token, contextId, prompt })}\n`
      );
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error("askpass response exceeded its bound"));
        return;
      }
      payload += chunk.toString("utf8");
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (settled) return;
      try {
        const record = JSON.parse(payload.trim()) as Record<string, unknown>;
        if (record.status === "cancelled") {
          finish(null, null);
          return;
        }
        if (
          record.status !== "ok" ||
          typeof record.response !== "string" ||
          Buffer.byteLength(record.response, "utf8") > 4_096 ||
          /[\0\r\n]/u.test(record.response)
        ) {
          throw new Error("askpass broker returned an invalid response");
        }
        finish(null, record.response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function requireEnvironment(name: string, maxBytes: number): string {
  const value = process.env[name];
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`missing or invalid ${name}`);
  }
  return value;
}
