/** 真 Vercel 部署用的入口：只把探针处理器以 ESM 默认导出交出去，由 build-vercel.mjs 打成单文件 bundle.js */
import worker from "../edge-runtime-check/worker.mjs"

export default worker
