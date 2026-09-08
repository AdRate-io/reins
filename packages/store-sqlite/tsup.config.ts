import { defineConfig } from "tsup"

/** paths 只给 tsc -b 用；打 .d.ts 时清掉，否则 @reins/core 的类型会被内联进本包声明 */
export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node.ts" },
  format: ["esm"],
  // tsup 8 缺省 removeNodeProtocol=true，会把 "node:sqlite" 改写成裸的 "sqlite"（一个不存在的 npm 包，运行时报 ERR_MODULE_NOT_FOUND）。
  // 本包的 /node 子路径就是为了用 node:sqlite，前缀必须保留
  removeNodeProtocol: false,
  dts: { compilerOptions: { composite: false, paths: {} } },
  clean: true,
  sourcemap: true,
})
