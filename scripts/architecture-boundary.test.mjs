import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const productionRoots = [
  "apps/desktop/src/renderer/src",
  "apps/desktop/src/pty-host",
  "apps/desktop/src/shared",
  "packages/core/src",
  "packages/proto/src",
  "packages/ui/src"
];
const isolatedRuntimeRoots = [
  "apps/desktop/src/renderer/src",
  "apps/desktop/src/pty-host",
  "apps/desktop/src/shared"
];
const rendererSafeSharedPlatformRoots = ["apps/desktop/src/shared/platform"];
const desktopPtyProtocolContractFiles = [
  "apps/desktop/src/shared/ptyProtocol.ts"
];
const packageContractRoots = [
  "packages/core/src",
  "packages/proto/src",
  "packages/ui/src"
];
const protoContractRoots = ["packages/proto/src"];
const cliRoots = ["packages/cli/src"];
const linuxPhaseWireContractRoots = [
  "packages/proto/src",
  "packages/cli/src",
  "packages/persistence/src",
  "apps/desktop/src/main",
  "apps/desktop/src/preload",
  "apps/desktop/src/shared"
];
const runtimePlatformAllowedFiles = new Set([
  "apps/desktop/src/pty-host/nodePtyLoader.ts"
]);
const nativeModuleLoaderDisallowedSpecifiers = new Set([
  "child_process",
  "node:child_process"
]);
const nativeModuleLoaderDisallowedPatterns = [
  ["macOS ditto shell tool", /\bditto\b/]
];
const desktopPtyProtocolTypeNames = [
  "DesktopPtySpawnRequest",
  "PtyEvent",
  "PtyRequest",
  "PtySessionSpec",
  "ShellLaunchPolicy"
];
const ptyHostDisallowedPackagePrefixes = [
  "@kmux/core",
  "@kmux/persistence",
  "@kmux/metadata",
  "@kmux/ui"
];
const ptyHostDisallowedPlatformPolicyHelpers = [
  "resolveDefaultShellArgs",
  "shouldApplyShellIntegration",
  "shouldStripShellManagedEnv",
  "ShellPolicyPlatform"
];
const sharedPlatformDisallowedPackagePrefixes = [
  "@kmux/core",
  "@kmux/persistence",
  "@kmux/metadata"
];
const nodeBuiltinSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);
const rendererBootstrapPlatformFallbackAllowedFiles = new Set([
  "apps/desktop/src/renderer/src/App.tsx"
]);
const rendererPlatformSniffPattern =
  /\bnavigator\.(?:platform|userAgent|userAgentData)\b/;
const desktopPtyProtocolRuntimeGlobalPatterns = [
  ["NodeJS namespace", /\bNodeJS\./],
  ["process global", /\bprocess\./]
];

function listSourceFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  return entries.flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    if (
      entry.isFile() &&
      sourceExtensions.has(path.extname(entry.name)) &&
      !entry.name.includes(".test.") &&
      !entry.name.endsWith(".d.ts")
    ) {
      return [entryPath];
    }
    return [];
  });
}

function normalized(filePath) {
  return filePath.split(path.sep).join("/");
}

function readSourceFiles(roots) {
  return roots.flatMap((root) =>
    listSourceFiles(root).map((filePath) => ({
      filePath: normalized(filePath),
      source: readFileSync(filePath, "utf8")
    }))
  );
}

function importSpecifiers(source) {
  const specifiers = [];
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importPattern)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

function isMainProcessSpecifier(specifier) {
  return (
    specifier === "../../main" ||
    specifier === "../main" ||
    specifier.includes("/main/") ||
    specifier.endsWith("/main")
  );
}

function isPtyHostDisallowedPackageSpecifier(specifier) {
  return ptyHostDisallowedPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  );
}

function isSharedPlatformDisallowedSpecifier(specifier) {
  return (
    nodeBuiltinSpecifiers.has(specifier) ||
    specifier === "electron" ||
    specifier.startsWith("electron/") ||
    isMainProcessSpecifier(specifier) ||
    sharedPlatformDisallowedPackagePrefixes.some(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
    )
  );
}

function isDesktopPtyProtocolDisallowedSpecifier(specifier) {
  return (
    nodeBuiltinSpecifiers.has(specifier) ||
    specifier === "electron" ||
    specifier.startsWith("electron/") ||
    isMainProcessSpecifier(specifier) ||
    ptyHostDisallowedPackagePrefixes.some(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
    )
  );
}

function isProtoContractDisallowedSpecifier(specifier) {
  return (
    nodeBuiltinSpecifiers.has(specifier) ||
    specifier === "electron" ||
    specifier.startsWith("electron/") ||
    specifier.includes("apps/desktop") ||
    isMainProcessSpecifier(specifier)
  );
}

describe("architecture boundaries", () => {
  it("keeps direct runtime platform globals out of renderer, shared, core, UI, and pty-host policy code", () => {
    const violations = readSourceFiles(productionRoots)
      .filter(({ filePath, source }) => {
        if (runtimePlatformAllowedFiles.has(filePath)) {
          return false;
        }
        return /\bprocess\.(?:platform|arch)\b/.test(source);
      })
      .map(({ filePath }) => filePath);

    expect(violations).toEqual([]);
  });

  it("keeps renderer, shared contracts, and pty-host isolated from Electron and main-process services", () => {
    const violations = readSourceFiles(isolatedRuntimeRoots).flatMap(
      ({ filePath, source }) =>
        importSpecifiers(source)
          .filter(
            (specifier) =>
              specifier === "electron" ||
              specifier.startsWith("electron/") ||
              isMainProcessSpecifier(specifier)
          )
          .map((specifier) => `${filePath} imports ${specifier}`)
    );

    expect(violations).toEqual([]);
  });

  it("keeps pty-host isolated from app service packages", () => {
    const violations = readSourceFiles(["apps/desktop/src/pty-host"]).flatMap(
      ({ filePath, source }) =>
        importSpecifiers(source)
          .filter(isPtyHostDisallowedPackageSpecifier)
          .map((specifier) => `${filePath} imports ${specifier}`)
    );

    expect(violations).toEqual([]);
  });

  it("keeps the CLI on shared socket/path contracts instead of desktop internals", () => {
    const sourceFiles = readSourceFiles(cliRoots);
    const importViolations = sourceFiles.flatMap(({ filePath, source }) =>
      importSpecifiers(source)
        .filter(
          (specifier) =>
            specifier.includes("apps/desktop") || isMainProcessSpecifier(specifier)
        )
        .map((specifier) => `${filePath} imports ${specifier}`)
    );
    const hardcodedSocketViolations = sourceFiles
      .filter(({ source }) => /(?:\.kmux|control\.sock)/.test(source))
      .map(({ filePath }) => `${filePath} hardcodes the default socket path`);

    expect([...importViolations, ...hardcodedSocketViolations]).toEqual([]);
  });

  it("keeps platform shell policy decisions out of pty-host runtime", () => {
    const violations = readSourceFiles(["apps/desktop/src/pty-host"]).flatMap(
      ({ filePath, source }) =>
        ptyHostDisallowedPlatformPolicyHelpers
          .filter((helperName) =>
            new RegExp(`\\b${helperName}\\b`).test(source)
          )
          .map((helperName) => `${filePath} references ${helperName}`)
    );

    expect(violations).toEqual([]);
  });

  it("keeps shared platform contracts renderer-safe", () => {
    const violations = readSourceFiles(rendererSafeSharedPlatformRoots).flatMap(
      ({ filePath, source }) =>
        importSpecifiers(source)
          .filter(isSharedPlatformDisallowedSpecifier)
          .map((specifier) => `${filePath} imports ${specifier}`)
    );

    expect(violations).toEqual([]);
  });

  it("keeps the desktop pty protocol contract free of runtime services", () => {
    const importViolations = desktopPtyProtocolContractFiles.flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return importSpecifiers(source)
        .filter(isDesktopPtyProtocolDisallowedSpecifier)
        .map((specifier) => `${filePath} imports ${specifier}`);
    });
    const runtimeGlobalViolations = desktopPtyProtocolContractFiles.flatMap(
      (filePath) => {
        const source = readFileSync(filePath, "utf8");
        return desktopPtyProtocolRuntimeGlobalPatterns
          .filter(([, pattern]) => pattern.test(source))
          .map(([label]) => `${filePath} references ${label}`);
      }
    );

    expect([...importViolations, ...runtimeGlobalViolations]).toEqual([]);
  });

  it("keeps proto package contracts free of runtime implementation imports", () => {
    const violations = readSourceFiles(protoContractRoots).flatMap(
      ({ filePath, source }) =>
        importSpecifiers(source)
          .filter(isProtoContractDisallowedSpecifier)
          .map((specifier) => `${filePath} imports ${specifier}`)
    );

    expect(violations).toEqual([]);
  });

  it("keeps the Linux-phase IPC wire contract on KMUX_SOCKET_PATH", () => {
    const endpointEnvViolations = readSourceFiles(
      linuxPhaseWireContractRoots
    ).flatMap(({ filePath, source }) =>
      /\bKMUX_IPC_ENDPOINT\b/.test(source)
        ? [`${filePath} references KMUX_IPC_ENDPOINT`]
        : []
    );
    const protoSource = readFileSync("packages/proto/src/index.ts", "utf8");
    const shellIdentity = /export interface ShellIdentity \{([\s\S]*?)\n\}/.exec(
      protoSource
    )?.[1];

    expect(endpointEnvViolations).toEqual([]);
    expect(shellIdentity).toBeTruthy();
    expect(shellIdentity).toMatch(/\bsocketPath:\s*string\b/);
    expect(shellIdentity).not.toMatch(/\bipcEndpoint\b/);
  });

  it("keeps renderer platform sniffing scoped to the bootstrap descriptor fallback", () => {
    const rendererFiles = readSourceFiles(["apps/desktop/src/renderer/src"]);
    const violations = rendererFiles
      .filter(
        ({ filePath, source }) =>
          !rendererBootstrapPlatformFallbackAllowedFiles.has(filePath) &&
          rendererPlatformSniffPattern.test(source)
      )
      .map(({ filePath }) => filePath);

    expect(violations).toEqual([]);

    for (const filePath of rendererBootstrapPlatformFallbackAllowedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source).toMatch(rendererPlatformSniffPattern);
      expect(source).toMatch(/\bcreateFallbackRendererPlatformDescriptor\b/);
      expect(source).toMatch(/\bgetPlatform\(\)/);
    }
  });

  it("keeps desktop-owned pty IPC contracts out of shared packages", () => {
    const packageSources = readSourceFiles(packageContractRoots);
    const importViolations = packageSources.flatMap(({ filePath, source }) =>
      importSpecifiers(source)
        .filter(
          (specifier) =>
            specifier.includes("apps/desktop") ||
            specifier.includes("ptyProtocol")
        )
        .map((specifier) => `${filePath} imports ${specifier}`)
    );
    const typeViolations = packageSources.flatMap(({ filePath, source }) =>
      desktopPtyProtocolTypeNames
        .filter((typeName) =>
          new RegExp(`\\b(?:interface|type)\\s+${typeName}\\b`).test(source)
        )
        .map((typeName) => `${filePath} declares ${typeName}`)
    );

    expect(importViolations).toEqual([]);
    expect(typeViolations).toEqual([]);
  });

  it("keeps the documented native-module platform exception explicit", () => {
    for (const filePath of runtimePlatformAllowedFiles) {
      expect(statSync(filePath).isFile()).toBe(true);
      expect(readFileSync(filePath, "utf8")).toMatch(
        /native module|node-pty|prebuild|abi/i
      );
    }
  });

  it("keeps the native-module loader free of platform shell copy tools", () => {
    const violations = [...runtimePlatformAllowedFiles].flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      const importViolations = importSpecifiers(source)
        .filter((specifier) =>
          nativeModuleLoaderDisallowedSpecifiers.has(specifier)
        )
        .map((specifier) => `${filePath} imports ${specifier}`);
      const patternViolations = nativeModuleLoaderDisallowedPatterns
        .filter(([, pattern]) => pattern.test(source))
        .map(([label]) => `${filePath} references ${label}`);
      return [...importViolations, ...patternViolations];
    });

    expect(violations).toEqual([]);
  });
});
