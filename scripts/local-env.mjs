/**
 * 本地私有值（密钥、网关地址、测试账号 id）的唯一读取处：仓库根 `.env.local`（`.gitignore` 的 `.env*` 已覆盖）。
 * spikes 与 examples 都经这里取值，不再各自解析文档。已设的同名环境变量优先（`process.loadEnvFile` 不覆盖已有值）。
 * 变量清单与含义见 `.env.local` 里的注释；线路说明、模型清单见 `模型API测试信息.md`。
 */
import { existsSync } from "node:fs"

const ENV_FILE = new URL("../.env.local", import.meta.url)
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

/** 取一个必需的本地值；缺了直接抛错，点名缺哪个、去哪补 */
export function need(name) {
  load()
  const value = process.env[name]
  if (!value) throw new Error(`缺本地值 ${name}：在仓库根 .env.local 里补上，或设同名环境变量`)
  return value
}

/** 取一个可选的本地值；没有返回 undefined */
export function maybe(name) {
  load()
  return process.env[name] || undefined
}

/** Cloudflare AI Gateway 透传路径的基址：`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`，后接 `/anthropic/v1` 等 */
export function cfGatewayBase() {
  return `https://gateway.ai.cloudflare.com/v1/${need("CF_ACCOUNT_ID")}/${maybe("CF_GATEWAY_ID") ?? "reins-dev"}`
}
