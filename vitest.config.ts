import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/** 包间引用直接指到源码，测试不依赖先 build；更具体的子路径要排在前面 */
const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: "@reins/core/testing", replacement: src("core/src/testing/index.ts") },
      { find: "@reins/core", replacement: src("core/src/index.ts") },
      { find: "@reins/brain", replacement: src("brain/src/index.ts") },
      { find: "@reins/server/node", replacement: src("server/src/node.ts") },
      { find: "@reins/server", replacement: src("server/src/index.ts") },
      { find: "@reins/store-sqlite/node", replacement: src("store-sqlite/src/node.ts") },
      { find: "@reins/store-sqlite", replacement: src("store-sqlite/src/index.ts") },
      { find: "@reins/store-pg", replacement: src("store-pg/src/index.ts") },
      { find: "@reins/adapter-tanstack-ai", replacement: src("adapter-tanstack-ai/src/index.ts") },
      { find: "reins", replacement: src("reins/src/index.ts") },
      { find: "@reins/ui-agui", replacement: src("ui-agui/src/index.ts") },
    ],
  },
  test: { include: ["packages/*/src/**/*.test.ts"], passWithNoTests: true },
})
