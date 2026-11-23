import { homedir } from "node:os";
import { expect, it } from "vitest";
import { withAgentModelRpc } from "./modelRpc";

it("decodes fragmented metadata and ignores notifications before the response", async () => {
  const result = await withAgentModelRpc({
    command: process.execPath,
    args: [
      "--eval",
      `process.stdin.once('data', () => { const message = JSON.stringify({id:1,result:'한글'}); process.stdout.write(JSON.stringify({method:'notice'})+'\\n'); process.stdout.write(message.slice(0,8)); setTimeout(() => process.stdout.write(message.slice(8)+'\\n'), 5); });`
    ],
    env: process.env,
    homeDir: homedir(),
    decodeResponse: (message) =>
      typeof message.id === "number"
        ? { id: message.id, result: message.result }
        : undefined,
    query: (rpc) => rpc.request(1, { id: 1, method: "models" })
  });
  expect(result).toBe("한글");
});

it("bounds a nonresponsive CLI metadata query", async () => {
  await expect(
    withAgentModelRpc({
      command: process.execPath,
      args: ["--eval", "process.stdin.resume();"],
      env: process.env,
      homeDir: homedir(),
      timeoutMs: 100,
      decodeResponse: () => undefined,
      query: (rpc) => rpc.request(1, { id: 1, method: "models" })
    })
  ).rejects.toThrow(/timed out/u);
});
