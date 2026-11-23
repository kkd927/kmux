import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import {
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  type SurfaceSnapshotPayload
} from "@kmux/proto";

const historySchema = z
  .object({
    version: z.literal(1),
    surfaceId: z.string().min(1),
    sessionId: z.string().min(1),
    savedAt: z.string().datetime(),
    cols: z.number().int().min(1).max(4096),
    rows: z.number().int().min(1).max(4096),
    vt: z.string()
  })
  .strict();
export type TerminalHistory = z.infer<typeof historySchema>;
const maxFileBytes = 6 * TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES + 4096;

/** Display history only. No process identity, launch command, or input authority is restored. */
export class TerminalHistoryStore {
  constructor(private readonly root: string) {}

  save(
    snapshot: Pick<
      SurfaceSnapshotPayload,
      "surfaceId" | "sessionId" | "cols" | "rows" | "vt"
    >
  ): void {
    const record = historySchema.parse({
      ...snapshot,
      version: 1,
      savedAt: new Date().toISOString()
    });
    if (Buffer.byteLength(record.vt) > TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES)
      throw new Error("Terminal history exceeds its checkpoint limit");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const destination = join(this.root, historyKey(record));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), {
        mode: 0o600,
        flag: "wx"
      });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  load(identity: {
    surfaceId: string;
    sessionId: string;
  }): TerminalHistory | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(
        join(this.root, historyKey(identity)),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > maxFileBytes ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Terminal history is not a private bounded checkpoint");
      const record = historySchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (
        record.surfaceId !== identity.surfaceId ||
        record.sessionId !== identity.sessionId ||
        Buffer.byteLength(record.vt) > TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES
      )
        throw new Error("Terminal history identity or size does not match");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  retain(
    identities: readonly { surfaceId: string; sessionId: string }[]
  ): void {
    let files: string[];
    try {
      files = readdirSync(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const keep = new Set(identities.map(historyKey));
    for (const file of files)
      if (/^[a-f0-9]{64}\.json$/u.test(file) && !keep.has(file))
        rmSync(join(this.root, file), { force: true });
  }
}

function historyKey(identity: {
  surfaceId: string;
  sessionId: string;
}): string {
  return `${createHash("sha256")
    .update(JSON.stringify([identity.surfaceId, identity.sessionId]))
    .digest("hex")}.json`;
}
