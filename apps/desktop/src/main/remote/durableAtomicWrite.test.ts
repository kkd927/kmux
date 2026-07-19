import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  durableAtomicReplace,
  type DurableAtomicWriteFileSystem
} from "./durableAtomicWrite";

describe("durableAtomicReplace", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-durable-write-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("orders complete writes before file fsync, rename, and directory fsync", () => {
    const root = join(sandbox, "operations");
    const events: string[] = [];
    const descriptors = new Map<number, string>();
    const fileSystem = proxyFileSystem({
      open(path, flags, mode) {
        const fd = openSync(path, flags, mode);
        descriptors.set(fd, path);
        events.push(`open:${basename(path)}`);
        return fd;
      },
      write(fd, buffer, offset, length) {
        events.push(`write:${basename(descriptors.get(fd) ?? "unknown")}`);
        return writeSync(fd, buffer, offset, Math.min(length, 3));
      },
      fsync(fd) {
        events.push(`fsync:${basename(descriptors.get(fd) ?? "unknown")}`);
        fsyncSync(fd);
      },
      rename(from, to) {
        events.push(`rename:${basename(from)}:${basename(to)}`);
        renameSync(from, to);
      }
    });

    durableAtomicReplace(
      root,
      "operation.json",
      new TextEncoder().encode("complete-record"),
      { fileSystem, randomSuffix: () => "fixed" }
    );

    expect(readFileSync(join(root, "operation.json"), "utf8")).toBe(
      "complete-record"
    );
    const fileFsync = events.findIndex((event) =>
      event.startsWith("fsync:.operation.json.tmp")
    );
    const rename = events.findIndex((event) => event.startsWith("rename:"));
    const directoryFsync = events.findIndex(
      (event) => event === "fsync:operations"
    );
    expect(events.filter((event) => event.startsWith("write:"))).toHaveLength(
      Math.ceil("complete-record".length / 3)
    );
    expect(fileFsync).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(fileFsync);
    expect(directoryFsync).toBeGreaterThan(rename);
  });

  it("removes an unrenamed temporary file after file-fsync failure", () => {
    const root = join(sandbox, "operations");
    const descriptors = new Map<number, string>();
    const fileSystem = proxyFileSystem({
      open(path, flags, mode) {
        const fd = openSync(path, flags, mode);
        descriptors.set(fd, path);
        return fd;
      },
      fsync(fd) {
        const path = descriptors.get(fd) ?? "";
        if (basename(path).startsWith(".operation.json.tmp")) {
          throw new Error("injected file fsync failure");
        }
        fsyncSync(fd);
      }
    });

    expect(() =>
      durableAtomicReplace(root, "operation.json", new Uint8Array([1, 2, 3]), {
        fileSystem,
        randomSuffix: () => "failure"
      })
    ).toThrow(/injected/);
    expect(existsSync(join(root, "operation.json"))).toBe(false);
    expect(existsSync(join(root, ".operation.json.tmp-failure"))).toBe(false);
  });

  it("treats a post-rename directory-fsync error as ambiguous and permits retry", () => {
    const root = join(sandbox, "operations");
    const descriptors = new Map<number, string>();
    const fileSystem = proxyFileSystem({
      open(path, flags, mode) {
        const fd = openSync(path, flags, mode);
        descriptors.set(fd, path);
        return fd;
      },
      fsync(fd) {
        if (descriptors.get(fd) === root) {
          throw new Error("injected directory fsync failure");
        }
        fsyncSync(fd);
      }
    });

    expect(() =>
      durableAtomicReplace(root, "operation.json", new Uint8Array([7]), {
        fileSystem,
        randomSuffix: () => "ambiguous"
      })
    ).toThrow(/directory fsync/);
    expect(readFileSync(join(root, "operation.json"))).toEqual(
      Buffer.from([7])
    );

    durableAtomicReplace(root, "operation.json", new Uint8Array([7]), {
      randomSuffix: () => "retry"
    });
    expect(readFileSync(join(root, "operation.json"))).toEqual(
      Buffer.from([7])
    );
  });

  it("rejects symlink roots and targets instead of following them", () => {
    const realRoot = join(sandbox, "real");
    const linkedRoot = join(sandbox, "linked");
    mkdirSync(realRoot, { mode: 0o700 });
    symlinkSync(realRoot, linkedRoot);

    expect(() =>
      durableAtomicReplace(linkedRoot, "operation.json", new Uint8Array([1]))
    ).toThrow(/real directory/);

    const targetLink = join(realRoot, "operation.json");
    symlinkSync(join(sandbox, "outside"), targetLink);
    expect(() =>
      durableAtomicReplace(realRoot, "operation.json", new Uint8Array([1]))
    ).toThrow(/regular file/);
  });
});

function proxyFileSystem(overrides: {
  open?: (path: string, flags: number, mode?: number) => number;
  write?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number
  ) => number;
  fsync?: (fd: number) => void;
  rename?: (from: string, to: string) => void;
}): DurableAtomicWriteFileSystem {
  return {
    closeSync,
    existsSync,
    fsyncSync: overrides.fsync ?? fsyncSync,
    lstatSync,
    mkdirSync,
    openSync: overrides.open ?? openSync,
    renameSync: overrides.rename ?? renameSync,
    unlinkSync,
    writeSync: overrides.write ?? writeSync
  };
}
