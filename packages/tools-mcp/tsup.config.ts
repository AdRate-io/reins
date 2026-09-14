import { defineConfig } from "tsup"

/**
 * 两个入口：`index`（Web 标准，只有 Streamable HTTP）与 `node`（stdio，起子进程）。
 * - paths 只给 tsc -b 用；打 .d.ts 时清掉，否则 @reinsjs/core 的类型会被内联进本包声明。
 * - `removeNodeProtocol: false`：/node 入口的 `@modelcontextprotocol/client/stdio` 是外部依赖不会被打进来，
 *   但本包自己若引用 node:* 也必须保留前缀（store-sqlite 踩过的坑）；主入口一律不许出现 node:*，
 *   由 `pnpm check` 之外的 dist 自检（README 里的命令）盯着。
 */
export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts" },
  format: ["esm"],
  removeNodeProtocol: false,
  dts: { compilerOptions: { composite: false, paths: {} } },
  clean: true,
  sourcemap: true,
})
