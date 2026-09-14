import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/** 包间引用直接指到源码，测试不依赖先 build；更具体的子路径要排在前面 */
const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: "@reinsjs/core/testing", replacement: src("core/src/testing/index.ts") },
      { find: "@reinsjs/core", replacement: src("core/src/index.ts") },
      { find: "@reinsjs/brain/node", replacement: src("brain/src/node.ts") },
      { find: "@reinsjs/brain", replacement: src("brain/src/index.ts") },
      { find: "@reinsjs/eval", replacement: src("eval/src/index.ts") },
      { find: "@reinsjs/server/node", replacement: src("server/src/node.ts") },
      { find: "@reinsjs/server", replacement: src("server/src/index.ts") },
      { find: "@reinsjs/store-sqlite/node", replacement: src("store-sqlite/src/node.ts") },
      { find: "@reinsjs/store-sqlite", replacement: src("store-sqlite/src/index.ts") },
      { find: "@reinsjs/store-pg", replacement: src("store-pg/src/index.ts") },
      { find: "@reinsjs/adapter-tanstack-ai", replacement: src("adapter-tanstack-ai/src/index.ts") },
      { find: "@reinsjs/tools-mcp/node", replacement: src("tools-mcp/src/node.ts") },
      { find: "@reinsjs/tools-mcp", replacement: src("tools-mcp/src/index.ts") },
      { find: "@reinsjs/agent", replacement: src("agent/src/index.ts") },
      { find: "@reinsjs/ui-agui", replacement: src("ui-agui/src/index.ts") },
    ],
  },
  test: { include: ["packages/*/src/**/*.test.ts", "examples/*/**/*.test.ts"], passWithNoTests: true },
})
