import { defineConfig } from "tsup"

/**
 * paths 是给 tsc -b 类型检查用的（映射到各包源码）；打包 .d.ts 时必须清掉，
 * 否则 @reins/core 的类型会被内联进本包的声明文件，而不是保留为 import。
 */
export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts" },
  format: ["esm"],
  // tsup 8 缺省 removeNodeProtocol=true，会把 "node:fs/promises" 改写成裸的 "fs/promises"（见踩坑记录 store-sqlite）。
  // 本包的 /node 子路径就是为了用 node:fs，前缀必须保留；主入口零 node:*，由 pnpm check:dist 核对
  removeNodeProtocol: false,
  dts: { compilerOptions: { composite: false, paths: {} } },
  clean: true,
  sourcemap: true,
})
