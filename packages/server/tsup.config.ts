import { defineConfig } from "tsup"

/**
 * paths 是给 tsc -b 类型检查用的（映射到各包源码）；打包 .d.ts 时必须清掉，
 * 否则 @reinsjs/core 的类型会被内联进本包的声明文件，而不是保留为 import。
 */
export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts" },
  format: ["esm"],
  dts: { compilerOptions: { composite: false, paths: {} } },
  clean: true,
  sourcemap: true,
  // /node 入口目前只 import type，但和 store-sqlite / tools-mcp 一样显式关掉：tsup 8 缺省会把 "node:*" 剥成裸名
  removeNodeProtocol: false,
})
