import { z } from 'zod'
import { paymentStats } from '../../services/purchases/payments'

const query = z.object({ workOrderNumber: z.string().max(64).optional() })

/** 付款申请页顶部统计卡：待付、暂缓、卡交期未付、已付（只数可见工单上的，与 GET /api/payments 同一范围） */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  return paymentStats({ workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)) })
})
