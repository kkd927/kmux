import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const currentDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
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
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"]
  }
});
