import { z } from 'zod'
import { scanRules } from '../../services/alerts/scan'

const body = z.object({ plusDays: z.number().min(0).max(60).optional() }).strict()

/** 立即跑一轮预警扫描；plusDays 把时钟往后拨（演示 Q12 用）。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  const { plusDays = 0 } = await parseBody(event, body)
  const now = new Date(Date.now() + plusDays * 86_400_000)
  return { now, ...(await scanRules(now)) }
})
