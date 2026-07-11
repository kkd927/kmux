import {
  SHELL_ENV_PROBE_MAX_OUTPUT_BYTES,
  ShellEnvProbeOutputBuffer
} from "./shellEnvProbeOutput";

describe("shell environment probe output", () => {
  it("rejects the chunk that would exceed the UTF-8 byte ceiling", () => {
    const output = new ShellEnvProbeOutputBuffer(5);

    expect(output.append("abc")).toBe(true);
    expect(output.append("é")).toBe(true);
    expect(output.append("x")).toBe(false);
    expect(output.toString()).toBe("abcé");
  });

  it("uses the same 8 MiB ceiling as non-PTY shell probing", () => {
    expect(SHELL_ENV_PROBE_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
  });
});
