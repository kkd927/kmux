import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseUint64Decimal, type RemoteSpoolEventDto } from "@kmux/proto";

import {
  RemoteEventReceiptConflictError,
  createRemoteEventReceiptStore
} from "./remoteEventReceiptStore";

describe("remote event receipt store", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a staged event and advances only after explicit completion", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-event-receipt-"));
    roots.push(root);
    const event = spoolEvent();
    const first = createRemoteEventReceiptStore(root);

    expect(first.stage(event)).toMatchObject({
      appliedThrough: 0n,
      pending: { eventId: "event_1", sequence: "1" }
    });

    const recovered = createRemoteEventReceiptStore(root);
    expect(recovered.load("desktop_1", "target_1")).toMatchObject({
      appliedThrough: 0n,
      pending: { eventId: "event_1" }
    });
    expect(recovered.complete(event)).toEqual({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      appliedThrough: parseUint64Decimal("1")
    });
    expect(recovered.stage(event)).toEqual({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      appliedThrough: parseUint64Decimal("1")
    });
  });

  it("rejects a different event while a durable pending receipt exists", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-event-conflict-"));
    roots.push(root);
    const store = createRemoteEventReceiptStore(root);
    store.stage(spoolEvent());

    expect(() =>
      store.stage(spoolEvent({ sequence: "2", eventId: "event_2" }))
    ).toThrow(RemoteEventReceiptConflictError);
    expect(() =>
      store.complete(spoolEvent({ sequence: "2", eventId: "event_2" }))
    ).toThrow(RemoteEventReceiptConflictError);
  });

  it("rejects a sequence gap before staging durable product work", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-event-gap-"));
    roots.push(root);
    const store = createRemoteEventReceiptStore(root);

    expect(() =>
      store.stage(spoolEvent({ sequence: "2", eventId: "event_2" }))
    ).toThrow(/not contiguous/u);
    expect(store.load("desktop_1", "target_1")).toEqual({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      appliedThrough: 0n
    });
  });

  it("fails closed on a symlinked or tampered receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-event-unsafe-"));
    roots.push(root);
    const store = createRemoteEventReceiptStore(root);
    store.stage(spoolEvent());
    const [receiptPath] = findJsonFiles(root);
    const original = readFileSync(receiptPath, "utf8");
    writeFileSync(receiptPath, original.replace("event_1", "event_X"), {
      mode: 0o600
    });
    expect(() => store.load("desktop_1", "target_1")).toThrow(/digest/u);

    rmSync(receiptPath);
    const victim = join(root, "victim.json");
    writeFileSync(victim, original, { mode: 0o600 });
    symlinkSync(victim, receiptPath);
    expect(() => store.load("desktop_1", "target_1")).toThrow(/private/u);
  });
});

function spoolEvent(
  overrides: Partial<RemoteSpoolEventDto> = {}
): RemoteSpoolEventDto {
  return {
    version: 1,
    sequence: "1",
    eventId: "event_1",
    kind: "notification",
    name: "finished",
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    },
    surfaceId: "surface_1",
    keeperGeneration: "keeper_1",
    createdAtUnixMs: "1",
    payload: { title: "Done", message: "Ready" },
    ...overrides
  };
}

function findJsonFiles(root: string): string[] {
  return readdirSync(root)
    .filter((name: string) => name.endsWith(".json"))
    .map((name: string) => join(root, name));
}
