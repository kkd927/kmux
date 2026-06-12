import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { openSettingsJsonFile, openWithMacTextEditor } from "./settingsJson";

describe("settings json opener", () => {
  it("opens settings.json through the macOS text editor path first", async () => {
    const shell = {
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn()
    };
    const openWithTextEditor = vi.fn(async () => "");

    const result = await openSettingsJsonFile({
      nodeEnv: "production",
      platform: "darwin",
      settingsPath: "/tmp/kmux/settings.json",
      shell,
      openWithTextEditor
    });

    expect(result).toEqual({ action: "opened" });
    expect(openWithTextEditor).toHaveBeenCalledWith("/tmp/kmux/settings.json");
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals settings.json in Finder if every opener reports an error", async () => {
    const shell = {
      openPath: vi.fn(async () => "no default application"),
      showItemInFolder: vi.fn()
    };

    const result = await openSettingsJsonFile({
      nodeEnv: "production",
      platform: "darwin",
      settingsPath: "/tmp/kmux/settings.json",
      shell,
      openWithTextEditor: vi.fn(async () => "TextEdit unavailable")
    });

    expect(result).toEqual({
      action: "revealed",
      error: "no default application"
    });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(
      "/tmp/kmux/settings.json"
    );
  });

  it("falls back to shell.openPath when the macOS text editor opener fails", async () => {
    const shell = {
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn()
    };

    const result = await openSettingsJsonFile({
      nodeEnv: "production",
      platform: "darwin",
      settingsPath: "/tmp/kmux/settings.json",
      shell,
      openWithTextEditor: vi.fn(async () => "open -t exited with code 1")
    });

    expect(result).toEqual({ action: "opened" });
    expect(shell.openPath).toHaveBeenCalledWith("/tmp/kmux/settings.json");
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("uses shell.openPath directly on Linux", async () => {
    const shell = {
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn()
    };
    const openWithTextEditor = vi.fn(async () => "");

    const result = await openSettingsJsonFile({
      nodeEnv: "production",
      platform: "linux",
      settingsPath: "/home/test/.config/kmux/settings.json",
      shell,
      openWithTextEditor
    });

    expect(result).toEqual({ action: "opened" });
    expect(openWithTextEditor).not.toHaveBeenCalled();
    expect(shell.openPath).toHaveBeenCalledWith(
      "/home/test/.config/kmux/settings.json"
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("does not launch external applications during e2e test runs", async () => {
    const shell = {
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn()
    };

    const result = await openSettingsJsonFile({
      nodeEnv: "test",
      platform: "darwin",
      settingsPath: "/tmp/kmux/settings.json",
      shell,
      openWithTextEditor: vi.fn(async () => "")
    });

    expect(result).toEqual({ action: "skipped-test" });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reports macOS text editor success only after open exits cleanly", async () => {
    const child = new EventEmitter() as ChildProcess;
    const spawnProcess = vi.fn(() => child);

    const result = openWithMacTextEditor(
      "/tmp/kmux/settings.json",
      spawnProcess
    );
    child.emit("close", 0, null);

    await expect(result).resolves.toBe("");
    expect(spawnProcess).toHaveBeenCalledWith(
      "open",
      ["-t", "/tmp/kmux/settings.json"],
      {
        detached: true,
        stdio: "ignore"
      }
    );
  });

  it("reports a macOS text editor error when open exits non-zero", async () => {
    const child = new EventEmitter() as ChildProcess;
    const spawnProcess = vi.fn(() => child);

    const result = openWithMacTextEditor(
      "/tmp/kmux/settings.json",
      spawnProcess
    );
    child.emit("close", 1, null);

    await expect(result).resolves.toBe("open -t exited with code 1");
  });
});
