/**
 * 本地专用值（测试广告主 id 等）的唯一读取处：先看环境变量，再看根目录 `模型API测试信息.md`（已 gitignore）。
 * 公开仓库与录像里出现的广告主 / 计划 id 都是脱敏别名（DECISIONS 2026-09-09 E2、2026-09-14），真实值不进源码。
 */
import { readFileSync } from "node:fs"

function localValue(label: string, env: string): string {
  const fromEnv = process.env[env]
  if (fromEnv) return fromEnv
  const info = readFileSync(new URL("../../模型API测试信息.md", import.meta.url), "utf8")
  const m = info.match(new RegExp(`${label}[：:]\\s*\`([^\`]+)\``))
  if (!m?.[1]) throw new Error(`没在 模型API测试信息.md 里找到"${label}"；或设环境变量 ${env}`)
  return m[1]
}

/** Boss 的 TikTok 测试广告主（可随意写，不会投出去） */
export const advertiserId = (): string => localValue("测试广告主 id", "ADRATE_ADVERTISER_ID")
/** smoke / smoke-write 用的一条已 DISABLE 的计划 */
export const smokeCampaignId = (): string => localValue("冒烟用计划 id", "ADRATE_SMOKE_CAMPAIGN_ID")
