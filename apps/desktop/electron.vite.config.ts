import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../..");
const electronEsmCommonJsShim = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;
const commonJsSyntax = /__filename|__dirname|require\(|require\.resolve\(/u;

const safeElectronEsmShim = {
  name: "kmux:safe-electron-esm-shim",
  enforce: "post" as const,
  renderChunk(code: string, _chunk: unknown, output: { format?: string }) {
    if (
      output.format !== "es" ||
      !commonJsSyntax.test(code) ||
      code.includes(electronEsmCommonJsShim)
    ) {
      return null;
    }
    return `${electronEsmCommonJsShim}${code}`;
  }
};

const alias = {
  "@kmux/core/main/path-access": resolve(
    repoRoot,
    "packages/core/src/main/pathAccess.ts"
  ),
  "@kmux/core/main": resolve(repoRoot, "packages/core/src/main/index.ts"),
  "@kmux/core": resolve(repoRoot, "packages/core/src/index.ts"),
  "@kmux/proto": resolve(repoRoot, "packages/proto/src/index.ts"),
  "@kmux/persistence": resolve(repoRoot, "packages/persistence/src/index.ts"),
  "@kmux/metadata": resolve(repoRoot, "packages/metadata/src/index.ts"),
  "@kmux/ui": resolve(repoRoot, "packages/ui/src/index.ts")
};

export default defineConfig({
  main: {
    // electron-vite's ESM shim scanner can mistake an IPC string containing
    // "import" for a static import and splice its shim inside the string. Put
    // the equivalent Electron 30+ shim at a known-safe boundary first.
    plugins: [safeElectronEsmShim, externalizeDepsPlugin()],
    resolve: {
      alias
    },
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve(currentDir, "src/main/index.ts"),
          shellEnvProbeWorker: resolve(
            currentDir,
            "src/main/shellEnvProbeWorker.ts"
          ),
          usageScanWorker: resolve(currentDir, "src/main/usageScanWorker.ts"),
          remoteHost: resolve(currentDir, "src/remote-host/index.ts"),
          askpassClient: resolve(currentDir, "src/askpass-client/index.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias
    },
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: {
          index: resolve(currentDir, "src/preload/index.ts")
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "out/renderer"
    }
  }
});
