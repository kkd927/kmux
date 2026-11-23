import {
  captureTerminalCoordinator,
  captureTerminalWorkflowCaller,
  verifyTerminalCoordinator
} from "./localCoordinatorCaller";
const state = vi.hoisted(() => ({ stdout: "" }));
vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, value: { stdout: string }) => void
  ) => callback(null, { stdout: state.stdout })
}));
const start = "Mon Oct 5 12:00:00 2026";
const row = (
  pid: number,
  parent: number,
  executable: string,
  created = start
) => `${pid} ${parent} ${created} ${executable}\n`;
it.each([
  "/usr/local/bin/codex",
  "/usr/local/bin/claude",
  "/usr/local/bin/agy",
  "/usr/local/bin/node"
])(
  "attaches %s both under a shell and as the root terminal process",
  async (executable) => {
    state.stdout =
      row(10, 1, "/bin/zsh") +
      row(20, 10, executable) +
      row(30, 20, "/bin/bash") +
      row(40, 30, "/usr/local/bin/kmux");
    expect(await captureTerminalWorkflowCaller(10, 40)).toEqual({
      pid: 20,
      startedAt: start
    });
    expect(await captureTerminalWorkflowCaller(20, 40)).toEqual({
      pid: 20,
      startedAt: start
    });
    await expect(
      verifyTerminalCoordinator(10, 40, { pid: 20, startedAt: start })
    ).resolves.toBeUndefined();
  }
);
it("keeps plain shells standalone and rejects foreign or reused process identities", async () => {
  state.stdout =
    row(10, 1, "/bin/zsh") +
    row(20, 10, "/usr/local/bin/agy") +
    row(40, 10, "/usr/local/bin/kmux");
  expect(await captureTerminalWorkflowCaller(10, 40)).toBeUndefined();
  expect(await captureTerminalCoordinator(10, 40)).toEqual({
    pid: 10,
    startedAt: start
  });
  await expect(
    verifyTerminalCoordinator(10, 40, { pid: 20, startedAt: start })
  ).rejects.toThrow(/original Coordinator process/);
  state.stdout =
    row(10, 1, "/bin/zsh") +
    row(20, 10, "/usr/local/bin/agy", "Mon Oct 5 13:00:00 2026") +
    row(40, 20, "/usr/local/bin/kmux");
  await expect(
    verifyTerminalCoordinator(10, 40, { pid: 20, startedAt: start })
  ).rejects.toThrow(/original Coordinator process/);
  await expect(captureTerminalWorkflowCaller(99, 40)).rejects.toThrow(
    /authenticated live terminal/
  );
});
