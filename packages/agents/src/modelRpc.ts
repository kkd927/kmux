import { spawn } from "node:child_process";

interface JsonLineRpc {
  request(id: string | number, body: Record<string, unknown>): Promise<unknown>;
  notify(body: Record<string, unknown>): void;
}

/** Bounded metadata transport. Callers never create sessions or send prompts. */
export async function withAgentModelRpc<T>(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  homeDir: string;
  decodeResponse: (
    message: Record<string, unknown>
  ) => { id: string | number; result?: unknown; error?: string } | undefined;
  query: (rpc: JsonLineRpc) => Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  const child = spawn(options.command, options.args, {
    env: options.env,
    cwd: options.homeDir,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let failure: Error | undefined;
  let outputBytes = 0;
  let buffered = "";
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const countOutput = (chunk: string | Buffer) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 4 * 1024 * 1024) {
      fail(new Error("Agent model query exceeded its output limit"));
      return false;
    }
    return true;
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (!countOutput(chunk) || failure) return;
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const response = options.decodeResponse(modelRecord(JSON.parse(line)));
        if (!response) continue;
        const request = pending.get(response.id);
        if (!request) continue;
        pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error));
        else request.resolve(response.result);
      } catch {
        fail(new Error("Agent model query returned invalid JSON"));
        return;
      }
    }
  });
  child.stderr.on("data", countOutput);
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.once("exit", () => fail(new Error("Agent model query exited")));
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Agent model query timed out");
      fail(error);
      reject(error);
    }, options.timeoutMs ?? 10_000);
  });
  const write = (body: Record<string, unknown>) => {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(body)}\n`);
  };
  try {
    return await Promise.race([
      options.query({
        request(id, body) {
          if (failure) return Promise.reject(failure);
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            write(body);
          });
        },
        notify: write
      }),
      expired
    ]);
  } finally {
    clearTimeout(timeout!);
    fail(new Error("Agent model query closed"));
    child.stdin.end();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
    }
  }
}

export function modelRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent model metadata must be an object");
  return value as Record<string, unknown>;
}
