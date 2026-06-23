import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@kmux/core";

const { openPath } = vi.hoisted(() => ({
  openPath: vi.fn(async () => "")
}));

vi.mock("electron", () => ({
  shell: {
    openPath
  }
}));

import { openTerminalFilePath } from "./terminalFileOpen";

describe("openTerminalFilePath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kmux-terminal-file-"));
    openPath.mockReset();
    openPath.mockResolvedValue("");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opens an absolute existing file with shell.openPath", async () => {
    const filePath = writeTempFile("self_merge_proposal.html");

    await openTerminalFilePath({
      surfaceId: "surface_1",
      rawPath: filePath,
      getState: () => stateWithSurface("surface_1")
    });

    expect(openPath).toHaveBeenCalledWith(filePath);
  });

  it("expands home-relative paths", async () => {
    const homeDir = path.join(tempDir, "home");
    const filePath = writeTempFile("home/file.md");

    await openTerminalFilePath({
      surfaceId: "surface_1",
      rawPath: "~/file.md",
      homeDir,
      getState: () => stateWithSurface("surface_1")
    });

    expect(openPath).toHaveBeenCalledWith(filePath);
  });

  it("resolves relative paths against the surface cwd", async () => {
    const cwd = path.join(tempDir, "project");
    const filePath = writeTempFile("project/src/App.tsx");

    await openTerminalFilePath({
      surfaceId: "surface_1",
      rawPath: "src/App.tsx",
      getState: () => stateWithSurface("surface_1", cwd)
    });

    expect(openPath).toHaveBeenCalledWith(filePath);
  });

  it("resolves relative paths against captured output cwd before live surface cwd", async () => {
    const oldCwd = path.join(tempDir, "old");
    const liveCwd = path.join(tempDir, "live");
    const oldFilePath = writeTempFile("old/src/App.tsx");
    writeTempFile("live/src/App.tsx");

    await openTerminalFilePath({
      surfaceId: "surface_1",
      rawPath: "src/App.tsx",
      baseCwd: oldCwd,
      getState: () => stateWithSurface("surface_1", liveCwd)
    });

    expect(openPath).toHaveBeenCalledWith(oldFilePath);
  });

  it("opens the path without a line and column suffix when the exact path does not exist", async () => {
    const cwd = path.join(tempDir, "project");
    const filePath = writeTempFile("project/file.ts");

    await openTerminalFilePath({
      surfaceId: "surface_1",
      rawPath: "file.ts:10:2",
      getState: () => stateWithSurface("surface_1", cwd)
    });

    expect(openPath).toHaveBeenCalledWith(filePath);
  });

  it("rejects a missing surface without opening anything", async () => {
    const filePath = writeTempFile("file.md");

    await expect(
      openTerminalFilePath({
        surfaceId: "missing",
        rawPath: filePath,
        getState: () => stateWithSurface("surface_1")
      })
    ).rejects.toThrow("missing surface");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("rejects a relative path when the surface has no cwd", async () => {
    await expect(
      openTerminalFilePath({
        surfaceId: "surface_1",
        rawPath: "src/App.tsx",
        getState: () => stateWithSurface("surface_1")
      })
    ).rejects.toThrow("without a cwd");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("rejects non-existent paths without opening anything", async () => {
    await expect(
      openTerminalFilePath({
        surfaceId: "surface_1",
        rawPath: path.join(tempDir, "missing.md"),
        getState: () => stateWithSurface("surface_1")
      })
    ).rejects.toThrow("does not exist");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("rejects unsupported URL-like protocols without opening anything", async () => {
    await expect(
      openTerminalFilePath({
        surfaceId: "surface_1",
        rawPath: "file:///tmp/file.md",
        getState: () => stateWithSurface("surface_1")
      })
    ).rejects.toThrow("unsupported");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("treats a non-empty shell.openPath result as an error", async () => {
    const filePath = writeTempFile("file.md");
    openPath.mockResolvedValue("No application is associated with the file");

    await expect(
      openTerminalFilePath({
        surfaceId: "surface_1",
        rawPath: filePath,
        getState: () => stateWithSurface("surface_1")
      })
    ).rejects.toThrow("No application");
  });

  function writeTempFile(relativePath: string): string {
    const filePath = path.join(tempDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "");
    return filePath;
  }
});

function stateWithSurface(surfaceId: string, cwd?: string): AppState {
  return {
    surfaces: {
      [surfaceId]: {
        id: surfaceId,
        cwd
      }
    }
  } as unknown as AppState;
}
