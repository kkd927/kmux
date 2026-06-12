import { describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}));

vi.mock("node:util", () => ({
  promisify: () => execFileAsyncMock
}));

import { resolveListeningPorts } from "./index";

describe("resolveListeningPorts", () => {
  it("parses lsof listening ports", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: [
        "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
        "node 501 test 12u IPv4 0x0 0t0 TCP 127.0.0.1:5173 (LISTEN)",
        "node 501 test 13u IPv6 0x0 0t0 TCP *:3000 (LISTEN)",
        "node 501 test 14u IPv4 0x0 0t0 TCP 127.0.0.1:5173 (LISTEN)"
      ].join("\n"),
      stderr: ""
    });

    await expect(resolveListeningPorts(501)).resolves.toEqual([5173, 3000]);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "lsof",
      ["-Pan", "-p", "501", "-iTCP", "-sTCP:LISTEN"],
      expect.objectContaining({ env: process.env })
    );
  });

  it("isolates lsof failures as empty metadata", async () => {
    execFileAsyncMock.mockRejectedValue(new Error("lsof unavailable"));

    await expect(resolveListeningPorts(502)).resolves.toEqual([]);
  });
});
