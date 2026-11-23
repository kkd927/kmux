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
      "@kmux/core/main": resolve(currentDir, "packages/core/src/main/index.ts"),
      "@kmux/core": resolve(currentDir, "packages/core/src/index.ts"),
      "@kmux/proto": resolve(currentDir, "packages/proto/src/index.ts"),
      "@kmux/persistence": resolve(
        currentDir,
        "packages/persistence/src/index.ts"
      ),
      "@kmux/metadata/core": resolve(
        currentDir,
        "packages/metadata/src/core/index.ts"
      ),
      "@kmux/metadata/node": resolve(
        currentDir,
        "packages/metadata/src/node/index.ts"
      ),
      "@kmux/metadata": resolve(currentDir, "packages/metadata/src/index.ts"),
      "@kmux/agent-integration/planner": resolve(
        currentDir,
        "packages/agent-integration/src/planner.ts"
      ),
      "@kmux/agent-integration": resolve(
        currentDir,
        "packages/agent-integration/src/index.ts"
      ),
      "@kmux/agents/builtin-runtime": resolve(
        currentDir,
        "packages/agents/src/builtinRuntime.ts"
      ),
      "@kmux/agents/antigravity-session-index": resolve(
        currentDir,
        "packages/agents/src/builtins/antigravity/sessionIndex.ts"
      ),
      "@kmux/agents/builtin-hooks": resolve(
        currentDir,
        "packages/agents/src/builtinHooks.ts"
      ),
      "@kmux/agents/generated-hook-responses": resolve(
        currentDir,
        "packages/agents/src/generatedHookResponses.ts"
      ),
      "@kmux/agents/generated-command-wrappers": resolve(
        currentDir,
        "packages/agents/src/generatedCommandWrappers.ts"
      ),
      "@kmux/agents/builtin-subscriptions": resolve(
        currentDir,
        "packages/agents/src/builtinSubscriptions.ts"
      ),
      "@kmux/agents/composition": resolve(
        currentDir,
        "packages/agents/src/composition.ts"
      ),
      "@kmux/agents": resolve(currentDir, "packages/agents/src/index.ts"),
      "@kmux/orchestration/editor": resolve(
        currentDir,
        "packages/orchestration/src/editorDocument.ts"
      ),
      "@kmux/orchestration/scopes": resolve(
        currentDir,
        "packages/orchestration/src/scopes.ts"
      ),
      "@kmux/orchestration/node": resolve(
        currentDir,
        "packages/orchestration/src/node.ts"
      ),
      "@kmux/orchestration": resolve(
        currentDir,
        "packages/orchestration/src/index.ts"
      ),
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
