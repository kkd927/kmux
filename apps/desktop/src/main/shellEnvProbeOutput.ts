export const SHELL_ENV_PROBE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class ShellEnvProbeOutputBuffer {
  private chunks: string[] = [];

  private bytes = 0;

  constructor(
    private readonly maxBytes: number = SHELL_ENV_PROBE_MAX_OUTPUT_BYTES
  ) {}

  append(chunk: string): boolean {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (this.bytes + chunkBytes > this.maxBytes) {
      return false;
    }
    this.chunks.push(chunk);
    this.bytes += chunkBytes;
    return true;
  }

  toString(): string {
    return this.chunks.join("");
  }
}
