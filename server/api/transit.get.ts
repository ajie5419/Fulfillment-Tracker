import { z } from 'zod'
import { listTransit } from '../services/flow/transit'

const query = z.object({ workOrderNumber: z.string().max(64).optional(), supplierId: z.string().max(64).optional() })

/** 外协在途：可按工单、外协厂筛选 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  return listTransit({
    workOrderNumber: q.workOrderNumber || undefined,
    supplierId: q.supplierId || undefined,
    visibleWorkOrders: scopeWorkOrders(await getScope(event)),
  })
})
