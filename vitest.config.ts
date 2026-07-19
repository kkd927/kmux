import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const currentDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@kmux/core/main/path-access": resolve(
        currentDir,
        "packages/core/src/main/pathAccess.ts"
      ),
      "@kmux/core/main": resolve(
        currentDir,
        "packages/core/src/main/index.ts"
      ),
      "@kmux/core": resolve(currentDir, "packages/core/src/index.ts"),
      "@kmux/proto": resolve(currentDir, "packages/proto/src/index.ts"),
      "@kmux/persistence": resolve(
        currentDir,
        "packages/persistence/src/index.ts"
      ),
      "@kmux/metadata": resolve(currentDir, "packages/metadata/src/index.ts"),
      "@kmux/ui": resolve(currentDir, "packages/ui/src/index.ts")
    }
  },
  test: {
    environment: "node",
    globals: true,
    exclude: [
      ...configDefaults.exclude,
      "tests/ssh/integration/**",
      "tests/ssh/profile/**"
    ],
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts",
      "scripts/**/*.test.mjs"
    ]
  }
});
