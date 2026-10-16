import { generateDailyDigest } from '../../services/alerts/digest'

/** 立即生成今日汇总（不看 07:30；同人同日仍只有一条）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return generateDailyDigest({ force: true, adminIds: adminIds(event) })
})
