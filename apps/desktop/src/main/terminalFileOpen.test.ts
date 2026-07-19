import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encodeLocatedPathDto,
  locatedPathForTarget,
  type AppState
} from "@kmux/core";

const { openPath } = vi.hoisted(() => ({
  openPath: vi.fn(async () => "")
}));

vi.mock("electron", () => ({
  shell: {
    openPath
  }
}));

import {
  openTerminalFilePath as openTerminalFilePathImpl,
  resolveTerminalFileLinks as resolveTerminalFileLinksImpl
} from "./terminalFileOpen";

type OpenTerminalFilePathOptions = Parameters<
  typeof openTerminalFilePathImpl
>[0];
type ResolveTerminalFileLinksOptions = Parameters<
  typeof resolveTerminalFileLinksImpl
>[0];

function resolveTestLocalPath(
  path: Parameters<OpenTerminalFilePathOptions["resolveLocalPath"]>[0]
): string {
  if (path.kind !== "local") {
    throw new Error("test local provider rejected an SSH path");
  }
  return encodeLocatedPathDto(path).path;
}

function openTerminalFilePath(
  options: Omit<OpenTerminalFilePathOptions, "resolveLocalPath"> &
    Partial<Pick<OpenTerminalFilePathOptions, "resolveLocalPath">>
) {
  return openTerminalFilePathImpl({
    resolveLocalPath: resolveTestLocalPath,
    ...options
  });
}

function resolveTerminalFileLinks(
  options: Omit<ResolveTerminalFileLinksOptions, "resolveLocalPath"> &
    Partial<Pick<ResolveTerminalFileLinksOptions, "resolveLocalPath">>
) {
  return resolveTerminalFileLinksImpl({
    resolveLocalPath: resolveTestLocalPath,
    ...options
  });
}

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

  it("validates absolute, home-relative, cwd-relative, and captured-cwd links", () => {
    const cwd = path.join(tempDir, "project");
    const capturedCwd = path.join(tempDir, "captured");
    const absolutePath = writeTempFile("absolute.md");
    writeTempFile("home/file.md");
    writeTempFile("project/src/App.tsx");
    writeTempFile("captured/old/File.ts");

    const result = resolveTerminalFileLinks({
      surfaceId: "surface_1",
      candidates: [
        linkCandidate("absolute", absolutePath),
        linkCandidate("home", "~/file.md"),
        linkCandidate("relative", "src/App.tsx"),
        linkCandidate("captured", "old/File.ts", {
          baseCwd: capturedCwd
        })
      ],
      homeDir: path.join(tempDir, "home"),
      getState: () => stateWithSurface("surface_1", cwd)
    });

    expect(result.links.map((link) => link.id)).toEqual([
      "absolute",
      "home",
      "relative",
      "captured"
    ]);
    expect(result.links.map((link) => link.openRawPath)).toEqual([
      absolutePath,
      "~/file.md",
      "src/App.tsx",
      "old/File.ts"
    ]);
    expect(result.links.map((link) => link.resolvedPath)).toEqual([
      absolutePath,
      path.join(tempDir, "home/file.md"),
      path.join(tempDir, "project/src/App.tsx"),
      path.join(tempDir, "captured/old/File.ts")
    ]);
  });

  it("trims sentence punctuation only after exact path validation fails", () => {
    const cwd = path.join(tempDir, "project");
    writeTempFile("project/report.md");

    expect(
      resolveTerminalFileLinks({
        surfaceId: "surface_1",
        candidates: [linkCandidate("trimmed", "./report.md.")],
        getState: () => stateWithSurface("surface_1", cwd)
      }).links
    ).toEqual([
      {
        id: "trimmed",
        openRawPath: "./report.md",
        resolvedPath: path.join(cwd, "report.md"),
        linkText: "./report.md",
        startIndex: 0,
        endIndex: "./report.md".length
      }
    ]);

    writeTempFile("project/report.md.");

    expect(
      resolveTerminalFileLinks({
        surfaceId: "surface_1",
        candidates: [linkCandidate("exact", "./report.md.")],
        getState: () => stateWithSurface("surface_1", cwd)
      }).links[0]
    ).toMatchObject({
      id: "exact",
      openRawPath: "./report.md.",
      resolvedPath: path.join(cwd, "report.md."),
      linkText: "./report.md.",
      endIndex: "./report.md.".length
    });
  });

  it("trims bracket and comma sentence endings to an existing file", () => {
    const cwd = path.join(tempDir, "project");
    writeTempFile("project/foo.md");

    const result = resolveTerminalFileLinks({
      surfaceId: "surface_1",
      candidates: [linkCandidate("foo", "./foo.md],")],
      getState: () => stateWithSurface("surface_1", cwd)
    });

    expect(result.links).toEqual([
      {
        id: "foo",
        openRawPath: "./foo.md",
        resolvedPath: path.join(cwd, "foo.md"),
        linkText: "./foo.md",
        startIndex: 0,
        endIndex: "./foo.md".length
      }
    ]);
  });

  it("returns no validated links for missing or unsupported paths", () => {
    const cwd = path.join(tempDir, "project");
    writeTempFile("project/src/App.tsx");

    const result = resolveTerminalFileLinks({
      surfaceId: "surface_1",
      candidates: [
        linkCandidate("missing", path.join(tempDir, "missing.md")),
        linkCandidate("missing-cwd", "src/App.tsx"),
        linkCandidate("protocol", "https://example.com/file.md"),
        linkCandidate("nul", "src/App.tsx\0"),
        linkCandidate("home-name", "~other/file.md"),
        linkCandidate("overlong", `/${"a".repeat(4097)}`)
      ],
      getState: () => stateWithSurface("surface_1")
    });

    expect(result.links).toEqual([]);
    expect(
      resolveTerminalFileLinks({
        surfaceId: "missing",
        candidates: [linkCandidate("relative", "src/App.tsx")],
        getState: () => stateWithSurface("surface_1", cwd)
      }).links
    ).toEqual([]);
  });

  it("limits validation work and reuses resolved path checks for duplicate targets", () => {
    const cwd = path.join(tempDir, "project");
    const filePath = writeTempFile("project/src/App.tsx");
    const fileExists = vi.fn(
      (candidatePath: string) => candidatePath === filePath
    );
    const candidates = Array.from({ length: 70 }, (_value, index) =>
      linkCandidate(`candidate-${index}`, "src/App.tsx")
    );
    candidates[1] = {
      ...candidates[1],
      startIndex: 20,
      endIndex: 20 + "src/App.tsx".length
    };

    const result = resolveTerminalFileLinks({
      surfaceId: "surface_1",
      candidates,
      fileExists,
      getState: () => stateWithSurface("surface_1", cwd)
    });

    expect(result.links).toHaveLength(64);
    expect(result.links.at(0)).toMatchObject({
      id: "candidate-0",
      openRawPath: "src/App.tsx",
      resolvedPath: filePath
    });
    expect(result.links[1]).toMatchObject({
      id: "candidate-1",
      startIndex: 20,
      endIndex: 20 + "src/App.tsx".length
    });
    expect(result.links.at(-1)?.id).toBe("candidate-63");
    expect(fileExists).toHaveBeenCalledTimes(1);
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

  function linkCandidate(
    id: string,
    rawPath: string,
    options: { baseCwd?: string; hasSuffix?: boolean } = {}
  ) {
    return {
      id,
      rawPath,
      linkText: rawPath,
      startIndex: 0,
      endIndex: rawPath.length,
      hasSuffix: options.hasSuffix ?? false,
      ...(options.baseCwd !== undefined ? { baseCwd: options.baseCwd } : {})
    };
  }
});

function stateWithSurface(surfaceId: string, cwd?: string): AppState {
  return {
    surfaces: {
      [surfaceId]: {
        id: surfaceId,
        ...(cwd
          ? { cwd: locatedPathForTarget({ kind: "local" }, cwd) }
          : {})
      }
    }
  } as unknown as AppState;
}
