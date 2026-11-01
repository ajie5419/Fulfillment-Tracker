import { z } from 'zod'
import { createDemoInspection } from '../../services/dev/demo'

const body = z
  .object({
    workOrderNumber: z.string().min(1, '请选择工单').max(64),
    partId: z.string().max(64).nullish(),
    partName: z.string().max(191).nullish(),
    processId: z.string().max(64).nullish(),
    processName: z.string().max(191).nullish(),
    supplierId: z.string().max(64).nullish(),
    quantity: z.number().int().min(0).max(100000),
    category: z.enum(['INCOMING']).nullish(),
  })
  .strict()

/** 模拟 QMS 新增一条返厂报检（category = INCOMING 时是进货检验，确认采购行到货）并立即匹配。仅 NUXT_DEV_TOOLS=1 时可用 */
export default defineFlowHandler(async (event) => {
  requireDevTools(event)
  return createDemoInspection(await parseBody(event, body))
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestBody = z.input<typeof body>
