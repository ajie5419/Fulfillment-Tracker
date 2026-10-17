import { z } from 'zod'
import { failDemoInspection } from '../../../../services/dev/demo'

const body = z.object({ unqualifiedQuantity: z.number().int().min(0).max(100000) }).strict()

/** 模拟 QMS 检验结论：演示报检改为 已关闭 + 不合格，并立即转异常。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  const { unqualifiedQuantity } = await parseBody(event, body)
  return failDemoInspection(routeId(event), unqualifiedQuantity)
})
