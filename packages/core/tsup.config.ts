import { defineConfig } from "tsup"

/**
 * 两个入口：主包与 ./testing（一致性套件）。
 * tsconfig 里的 composite 是给 `tsc -b` 增量构建用的，tsup 生成 .d.ts 时按显式文件列表跑，
 * 与 composite 冲突（TS6307），所以此处单独关闭。
 */
export default defineConfig({
  entry: { index: "src/index.ts", "testing/index": "src/testing/index.ts" },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
})
