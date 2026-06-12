import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { KMUX_NATIVE_CACHE_ROOT_ENV } from "../shared/platform/env";
import {
  ensureExternalNodePtyRoot,
  resolveExternalNodePtyRoot,
  shouldExternalizeNodePty
} from "./nodePtyLoader";

describe("pty-host node-pty packaging helpers", () => {
  it("detects packaged app bundle node-pty paths for externalization", () => {
    expect(
      shouldExternalizeNodePty(
        "/Applications/kmux.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty",
        "darwin"
      )
    ).toBe(true);
    expect(
      shouldExternalizeNodePty(
        "/Applications/kmux.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty",
        "linux"
      )
    ).toBe(false);
    expect(
      shouldExternalizeNodePty(
        "/Users/test/kmux/node_modules/node-pty",
        "darwin"
      )
    ).toBe(false);
  });

  it("builds the external node-pty cache path from the runtime dir", () => {
    const nodePtyRoot = mkdtempSync(join(tmpdir(), "kmux-node-pty-test-"));
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );

    try {
      expect(
        resolveExternalNodePtyRoot(
          nodePtyRoot,
          { KMUX_RUNTIME_DIR: "/tmp/kmux-runtime" },
          "darwin",
          "x64",
          "127"
        )
      ).toBe(
        "/tmp/kmux-runtime/native/node-pty-1.2.3-darwin-x64-abi127"
      );
    } finally {
      rmSync(nodePtyRoot, { force: true, recursive: true });
    }
  });

  it("uses the explicit native cache root for Linux node-pty extraction", () => {
    const nodePtyRoot = mkdtempSync(join(tmpdir(), "kmux-node-pty-test-"));
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );

    try {
      expect(
        resolveExternalNodePtyRoot(
          nodePtyRoot,
          {
            KMUX_RUNTIME_DIR: "/run/user/1000/kmux",
            [KMUX_NATIVE_CACHE_ROOT_ENV]: "/home/test/.cache/kmux/native"
          },
          "linux",
          "arm64",
          "127"
        )
      ).toBe(
        "/home/test/.cache/kmux/native/node-pty-1.2.3-linux-arm64-abi127"
      );
    } finally {
      rmSync(nodePtyRoot, { force: true, recursive: true });
    }
  });

  it("falls back to the Linux XDG cache root when native cache env is blank", () => {
    const nodePtyRoot = mkdtempSync(join(tmpdir(), "kmux-node-pty-test-"));
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );

    try {
      expect(
        resolveExternalNodePtyRoot(
          nodePtyRoot,
          {
            KMUX_RUNTIME_DIR: "/run/user/1000/kmux",
            XDG_CACHE_HOME: "/home/test/.cache",
            [KMUX_NATIVE_CACHE_ROOT_ENV]: "   "
          },
          "linux",
          "x64",
          "127"
        )
      ).toBe(
        "/home/test/.cache/kmux/native/node-pty-1.2.3-linux-x64-abi127"
      );
    } finally {
      rmSync(nodePtyRoot, { force: true, recursive: true });
    }
  });

  it("ignores relative Linux native cache env values", () => {
    const nodePtyRoot = mkdtempSync(join(tmpdir(), "kmux-node-pty-test-"));
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );

    try {
      expect(
        resolveExternalNodePtyRoot(
          nodePtyRoot,
          {
            XDG_CACHE_HOME: "relative-cache",
            [KMUX_NATIVE_CACHE_ROOT_ENV]: "relative-native"
          },
          "linux",
          "x64",
          "127"
        )
      ).toBe(
        join(
          homedir(),
          ".cache",
          "kmux",
          "native",
          "node-pty-1.2.3-linux-x64-abi127"
        )
      );
    } finally {
      rmSync(nodePtyRoot, { force: true, recursive: true });
    }
  });

  it("treats a blank macOS runtime dir as absent for node-pty extraction", () => {
    const nodePtyRoot = mkdtempSync(join(tmpdir(), "kmux-node-pty-test-"));
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );

    try {
      expect(
        resolveExternalNodePtyRoot(
          nodePtyRoot,
          { KMUX_RUNTIME_DIR: "   " },
          "darwin",
          "x64",
          "127"
        )
      ).toBe(
        join(
          homedir(),
          ".kmux",
          "native",
          "node-pty-1.2.3-darwin-x64-abi127"
        )
      );
    } finally {
      rmSync(nodePtyRoot, { force: true, recursive: true });
    }
  });

  it("copies node-pty into the Linux native cache without platform shell tools", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-node-pty-externalize-"));
    const nodePtyRoot = join(root, "source-node-pty");
    const nativeCacheRoot = join(root, "native-cache");
    const buildSpawnHelper = join(
      nodePtyRoot,
      "build",
      "Release",
      "spawn-helper"
    );
    const prebuildSpawnHelper = join(
      nodePtyRoot,
      "prebuilds",
      "linux-arm64",
      "spawn-helper"
    );
    mkdirSync(join(nodePtyRoot, "build", "Release"), { recursive: true });
    mkdirSync(join(nodePtyRoot, "prebuilds", "linux-arm64"), {
      recursive: true
    });
    writeFileSync(
      join(nodePtyRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8"
    );
    writeFileSync(buildSpawnHelper, "#!/bin/sh\n");
    writeFileSync(prebuildSpawnHelper, "#!/bin/sh\n");

    try {
      const externalRoot = ensureExternalNodePtyRoot(
        nodePtyRoot,
        {
          [KMUX_NATIVE_CACHE_ROOT_ENV]: nativeCacheRoot
        },
        "linux",
        "arm64",
        "127"
      );

      expect(externalRoot).toBe(
        join(nativeCacheRoot, "node-pty-1.2.3-linux-arm64-abi127")
      );
      expect(existsSync(join(externalRoot, "package.json"))).toBe(true);
      expect(
        statSync(join(externalRoot, "build", "Release", "spawn-helper")).mode &
          0o111
      ).not.toBe(0);
      expect(
        statSync(join(externalRoot, "prebuilds", "linux-arm64", "spawn-helper"))
          .mode & 0o111
      ).not.toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
