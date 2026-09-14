import { defineConfig } from "tsup"

/**
 * 单入口、零依赖、零 node:*。paths 只给 tsc -b 用；打 .d.ts 时清掉，否则 @reinsjs/core 的类型会被内联进本包声明。
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { compilerOptions: { composite: false, paths: {} } },
  clean: true,
  sourcemap: true,
})
