import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stdout is mirrored to the terminal and captured before the PTY's newline
// translation. stderr and stdin stay attached to the terminal. The final
// consumer drains excess bytes so a bounded result never SIGPIPEs the command.
const captureScript = `
exec 4>"$1" || exit 125
/bin/rm -f "$1" || exit 125
limit=$2
shift 2
set -o pipefail
"$@" 4>&- | /usr/bin/tee /dev/stderr 4>&- | {
  /usr/bin/head -c "$limit" >&4 && /bin/cat >/dev/null
}
`;

export function captureJsonStdout(
  executable: string,
  args: string[],
  maxBytes: number
) {
  const path = join(tmpdir(), `kmux-stdout-${randomUUID()}`);
  const fd = openSync(path, "wx+", 0o600);
  let closed = false;
  return {
    shellPath: "/bin/bash",
    args: [
      "--noprofile",
      "--norc",
      "-c",
      captureScript,
      "kmux-json-stdout",
      path,
      String(maxBytes + 1),
      executable,
      ...args
    ],
    read() {
      const size = fstatSync(fd).size;
      if (size > maxBytes)
        return { output: "", outputBytes: size, truncated: true };
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(fd, bytes, offset, size - offset, offset);
        if (count === 0) throw new Error("Incomplete Shell stdout capture");
        offset += count;
      }
      return {
        output: bytes.toString("utf8"),
        outputBytes: size,
        truncated: false
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } finally {
        rmSync(path, { force: true });
      }
    }
  };
}
