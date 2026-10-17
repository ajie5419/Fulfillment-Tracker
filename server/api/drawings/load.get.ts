import { designLoad } from '../../services/drawings/drawings'
import { loadQuery } from '../../schemas/drawings'

/** 设计负荷：按设计负责人列在手、逾期、本周到期、待客户确认的任务数（只算可见工单上的） */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, loadQuery)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  return designLoad({ workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)) })
})
