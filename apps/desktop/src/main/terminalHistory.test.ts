import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { TerminalHistoryStore } from "./terminalHistory";

it("atomically replaces private display history, binds it to an exact session, and prunes removed terminals", () => {
  const root = mkdtempSync(join(tmpdir(), "kmux-terminal-history-"));
  try {
    const store = new TerminalHistoryStore(root);
    const identity = { surfaceId: "surface:first", sessionId: "session:first" };
    store.save({ ...identity, cols: 80, rows: 24, vt: "첫 번째 🚀" });
    store.save({ ...identity, cols: 120, rows: 30, vt: "두 번째 🚀" });
    expect(store.load(identity)).toMatchObject({
      ...identity,
      cols: 120,
      rows: 30,
      vt: "두 번째 🚀"
    });
    expect(
      store.load({ ...identity, sessionId: "session:replacement" })
    ).toBeUndefined();
    const files = readdirSync(root);
    expect(files).toHaveLength(1);
    expect(statSync(join(root, files[0]!)).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(join(root, files[0]!), "utf8"));
    writeFileSync(
      join(root, files[0]!),
      JSON.stringify({ ...record, sessionId: "session:forged" })
    );
    expect(() => store.load(identity)).toThrow(/identity/u);
    store.retain([]);
    expect(store.load(identity)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
