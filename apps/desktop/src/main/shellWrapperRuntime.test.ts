import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cleanupStaleAppZshWrapperDirs,
  createShellWrapperRuntime
} from "./shellWrapperRuntime";

describe("shell wrapper runtime", () => {
  it("creates one app-run zsh wrapper directory on macOS and cleans it up", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-wrapper-runtime-"));

    try {
      const runtime = createShellWrapperRuntime({
        platform: "darwin",
        tmpDir: root
      });

      expect(runtime.zshWrapperDir).toMatch(/kmux-zsh-app-/);
      expect(runtime.env.KMUX_ZSH_WRAPPER_DIR).toBe(runtime.zshWrapperDir);
      expect(existsSync(runtime.zshWrapperDir ?? "")).toBe(true);

      runtime.cleanup();
      runtime.cleanup();
      expect(existsSync(runtime.zshWrapperDir ?? "")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create wrapper directories off macOS", () => {
    const runtime = createShellWrapperRuntime({ platform: "linux" });

    expect(runtime.env).toEqual({});
    expect(runtime.zshWrapperDir).toBeUndefined();
  });

  it("removes only stale app-run wrapper directories whose owner is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-wrapper-runtime-"));
    const staleInactive = join(root, "kmux-zsh-app-stale-inactive");
    const staleActive = join(root, "kmux-zsh-app-stale-active");
    const staleUnknown = join(root, "kmux-zsh-app-stale-unknown");
    const fresh = join(root, "kmux-zsh-app-fresh");
    const unrelated = join(root, "kmux-zsh-other");

    try {
      mkdirSync(staleInactive);
      mkdirSync(staleActive);
      mkdirSync(staleUnknown);
      mkdirSync(fresh);
      mkdirSync(unrelated);
      writeFileSync(
        join(staleInactive, ".kmux-owner.json"),
        JSON.stringify({ pid: 101 })
      );
      writeFileSync(
        join(staleActive, ".kmux-owner.json"),
        JSON.stringify({ pid: 202 })
      );
      writeFileSync(
        join(fresh, ".kmux-owner.json"),
        JSON.stringify({ pid: 303 })
      );
      utimesSync(staleInactive, new Date(1_000), new Date(1_000));
      utimesSync(staleActive, new Date(1_000), new Date(1_000));
      utimesSync(staleUnknown, new Date(1_000), new Date(1_000));
      utimesSync(fresh, new Date(10_000), new Date(10_000));

      cleanupStaleAppZshWrapperDirs(root, {
        nowMs: 20_000,
        staleWrapperAgeMs: 15_000,
        isProcessAlive: (pid) => pid === 202
      });

      expect(existsSync(staleInactive)).toBe(false);
      expect(existsSync(staleActive)).toBe(true);
      expect(existsSync(staleUnknown)).toBe(true);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
