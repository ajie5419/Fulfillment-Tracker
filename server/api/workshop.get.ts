import { z } from 'zod'
import { listWorkshop } from '../services/flow/workshop'

const query = z.object({ wo: z.string().max(64).optional(), supplierId: z.string().max(64).optional() })

/** 车间看板（只读）：工序按状态分列，可按工单、班组 / 外协厂筛选；只列可见工单 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  const visibleWorkOrders = scopeWorkOrders(await getScope(event))
  if (q.wo) await assertCanSee(event, q.wo)
  return listWorkshop({ workOrderNumber: q.wo || undefined, supplierId: q.supplierId || undefined, visibleWorkOrders })
})
