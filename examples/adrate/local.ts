/**
 * 本地专用值（测试广告主 id 等）的唯一读取处：仓库根 `.env.local`（已 gitignore），经 scripts/local-env.mjs 读；
 * 同名环境变量优先。用到的变量：ADRATE_ADVERTISER_ID、ADRATE_SMOKE_CAMPAIGN_ID。
 * 公开仓库与录像里出现的广告主 / 计划 id 都是脱敏别名（DECISIONS 2026-09-09 E2、2026-09-14），真实值不进源码。
 */
import { need } from "../../scripts/local-env.mjs"

/** Boss 的 TikTok 测试广告主（可随意写，不会投出去） */
export const advertiserId = (): string => need("ADRATE_ADVERTISER_ID")
/** smoke / smoke-write 用的一条已 DISABLE 的计划 */
export const smokeCampaignId = (): string => need("ADRATE_SMOKE_CAMPAIGN_ID")
