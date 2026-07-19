import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

describe("target/path architecture", () => {
  it("keeps internal PathAccess imports inside the target composition root", () => {
    const repositoryRoot = resolve(".");
    const forbiddenImport = ["@kmux/core/main", "/path-access"].join("");
    const importers = sourceFiles(repositoryRoot).filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        source.includes(`from "${forbiddenImport}"`) ||
        source.includes(`from '${forbiddenImport}'`)
      );
    });

    expect(importers.map((path) => relative(repositoryRoot, path))).toEqual([
      "apps/desktop/src/main/targets/targetServiceRegistry.ts"
    ]);
  });

  it("keeps raw path extraction private to the domain capability module", () => {
    const repositoryRoot = resolve(".");
    const rawAccessName = ["pathRawValue", "ForInternalAccess"].join("");
    const users = sourceFiles(repositoryRoot).filter((path) =>
      readFileSync(path, "utf8").includes(rawAccessName)
    );

    expect(users.map((path) => relative(repositoryRoot, path))).toEqual([
      "packages/core/src/domain.ts",
      "packages/core/src/main/pathAccess.ts"
    ]);
  });

  it("keeps Main-only remote operation facts out of renderer source", () => {
    const rendererRoot = resolve("apps/desktop/src/renderer");
    const importers = listTypeScriptFiles(rendererRoot).filter((path) =>
      readFileSync(path, "utf8").includes("@kmux/core/main")
    );

    expect(importers).toEqual([]);
  });

  it("constructs the local path resolver only at the Main composition root", () => {
    const sourceRoot = resolve("apps/desktop/src");
    const constructors = listTypeScriptFiles(sourceRoot)
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) =>
        readFileSync(path, "utf8").includes("= createLocalPathResolver();")
      );

    expect(constructors.map((path) => relative(sourceRoot, path))).toEqual([
      "main/index.ts"
    ]);
  });

  it("keeps OpenSSH process helpers inside the remote-host utility boundary", () => {
    const sourceRoot = resolve("apps/desktop/src");
    const remoteHostRoot = join(sourceRoot, "remote-host");
    const importers = listTypeScriptFiles(sourceRoot)
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) => !path.startsWith(remoteHostRoot))
      .filter((path) =>
        readFileSync(path, "utf8").includes("remote-host/openSshProcess")
      );

    expect(importers.map((path) => relative(sourceRoot, path))).toEqual([]);
  });
});

function listTypeScriptFiles(root: string): string[] {
  const ignoredDirectories = new Set([
    ".git",
    "coverage",
    "dist",
    "node_modules",
    "out"
  ]);
  return readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory()
        ? ignoredDirectories.has(name)
          ? []
          : listTypeScriptFiles(path)
        : /\.[cm]?[jt]sx?$/.test(name)
          ? [path]
          : [];
    })
    .sort();
}

function sourceFiles(repositoryRoot: string): string[] {
  return ["apps", "packages", "scripts", "tests"]
    .flatMap((directory) =>
      listTypeScriptFiles(join(repositoryRoot, directory))
    )
    .sort();
}
