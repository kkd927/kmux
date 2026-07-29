import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readAntigravityConversationMetadataFromInventory,
  readAntigravityConversationMetadataFromRoot
} from "./antigravityStorage";
import { collectSessionInventory } from "./sessionInventory";

const OLD_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const RECENT_CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

describe("Antigravity conversation storage", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it("uses WAL activity for bounded selection and conversation timestamps", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-antigravity-storage-"));
    roots.push(root);
    const conversationsRoot = join(root, "conversations");
    mkdirSync(conversationsRoot, { recursive: true });

    const oldDbPath = join(conversationsRoot, `${OLD_CONVERSATION_ID}.db`);
    const oldWalPath = `${oldDbPath}-wal`;
    const recentDbPath = join(
      conversationsRoot,
      `${RECENT_CONVERSATION_ID}.db`
    );
    writeFileSync(oldDbPath, "not a sqlite database", "utf8");
    writeFileSync(oldWalPath, "pending sqlite writes", "utf8");
    writeFileSync(recentDbPath, "not a sqlite database", "utf8");

    const oldDbTime = new Date("2026-01-01T00:00:00.000Z");
    const recentDbTime = new Date("2026-06-01T00:00:00.000Z");
    const walTime = new Date("2026-07-01T00:00:00.000Z");
    utimesSync(oldDbPath, oldDbTime, oldDbTime);
    utimesSync(recentDbPath, recentDbTime, recentDbTime);
    utimesSync(oldWalPath, walTime, walTime);

    const records = readAntigravityConversationMetadataFromRoot(root, {
      maxConversationFiles: 1
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      conversationId: OLD_CONVERSATION_ID,
      mtimeMs: walTime.getTime(),
      updatedAt: walTime.toISOString()
    });
  });

  it("preserves WAL activity when parsing a shared inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-antigravity-inventory-"));
    roots.push(root);
    const conversationsRoot = join(root, "conversations");
    mkdirSync(conversationsRoot, { recursive: true });

    const oldDbPath = join(conversationsRoot, `${OLD_CONVERSATION_ID}.db`);
    const oldWalPath = `${oldDbPath}-wal`;
    const recentDbPath = join(
      conversationsRoot,
      `${RECENT_CONVERSATION_ID}.db`
    );
    writeFileSync(oldDbPath, "not a sqlite database", "utf8");
    writeFileSync(oldWalPath, "pending sqlite writes", "utf8");
    writeFileSync(recentDbPath, "not a sqlite database", "utf8");

    const oldDbTime = new Date("2026-01-01T00:00:00.000Z");
    const recentDbTime = new Date("2026-06-01T00:00:00.000Z");
    const walTime = new Date("2026-07-01T00:00:00.000Z");
    utimesSync(oldDbPath, oldDbTime, oldDbTime);
    utimesSync(recentDbPath, recentDbTime, recentDbTime);
    utimesSync(oldWalPath, walTime, walTime);

    const inventory = collectSessionInventory([root]);
    const records = readAntigravityConversationMetadataFromInventory(
      root,
      inventory.candidates,
      { maxConversationFiles: 1 }
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      conversationId: OLD_CONVERSATION_ID,
      mtimeMs: walTime.getTime(),
      updatedAt: walTime.toISOString()
    });
  });
});
