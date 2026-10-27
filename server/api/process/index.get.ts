import { listProcess } from '../../services/process/process'
import { listQuery } from '../../schemas/process'
import { canOperate } from '../../services/auth/permissions'

/** 工艺页：各部件（设计任务）的料单、工艺状态 + 统计。只列可见工单上的、未取消的设计任务 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, listQuery)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  const ctx = await getRoleContext(event)
  return listProcess(
    { workOrderNumber: q.workOrderNumber || undefined, view: q.view, q: q.q, visibleWorkOrders: scopeWorkOrders(await getScope(event)) },
    canOperate(ctx, 'processDoc'),
  )
})
