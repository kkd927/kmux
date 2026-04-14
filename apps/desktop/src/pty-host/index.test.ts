import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {resolveExternalNodePtyRoot, shouldExternalizeNodePty} from "./nodePtyLoader";

describe("pty-host node-pty packaging helpers", () => {
  it("detects packaged app bundle node-pty paths for externalization", () => {
    expect(
      shouldExternalizeNodePty(
        "/Applications/kmux.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty"
      )
    ).toBe(true);
    expect(
      shouldExternalizeNodePty("/Users/test/kmux/node_modules/node-pty")
    ).toBe(false);
  });

  it("builds the external node-pty cache path from the runtime dir", () => {
    const originalRuntimeDir = process.env.KMUX_RUNTIME_DIR;
    const nodePtyRoot = mkdtempSync(join(tmpdir(), "kmux-node-pty-test-"));
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );
    process.env.KMUX_RUNTIME_DIR = "/tmp/kmux-runtime";

    try {
      expect(resolveExternalNodePtyRoot(nodePtyRoot)).toBe(
        `/tmp/kmux-runtime/native/node-pty-1.2.3-${process.platform}-${process.arch}-abi${process.versions.modules}`
      );
    } finally {
      if (originalRuntimeDir === undefined) {
        delete process.env.KMUX_RUNTIME_DIR;
      } else {
        process.env.KMUX_RUNTIME_DIR = originalRuntimeDir;
      }
      rmSync(nodePtyRoot, { force: true, recursive: true });
    }
  });
});
