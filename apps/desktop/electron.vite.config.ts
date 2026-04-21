import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../..");

const alias = {
  "@kmux/core": resolve(repoRoot, "packages/core/src/index.ts"),
  "@kmux/proto": resolve(repoRoot, "packages/proto/src/index.ts"),
  "@kmux/persistence": resolve(repoRoot, "packages/persistence/src/index.ts"),
  "@kmux/metadata": resolve(repoRoot, "packages/metadata/src/index.ts"),
  "@kmux/ui": resolve(repoRoot, "packages/ui/src/index.ts")
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
          )
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
    plugins: [react()],
    build: {
      outDir: "out/renderer"
    }
  }
});
