import { listTasks } from '../../services/drawings/drawings'
import { listQuery } from '../../schemas/drawings'

/**
 * 设计任务列表 + 统计（设计中、设计完成、待客户确认、逾期、本周到期）。只列可见工单上的；
 * mine=1 时是"我的设计任务"：我是设计负责人的，不受工单可见范围限制。
 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, listQuery)
  const mine = q.mine === '1'
  if (q.workOrderNumber && !mine) await assertCanSee(event, q.workOrderNumber)
  return listTasks(
    {
      workOrderNumber: q.workOrderNumber || undefined,
      ownerId: mine ? user.qmsUserId : q.ownerId || undefined,
      view: q.view,
      q: q.q,
      visibleWorkOrders: mine ? undefined : scopeWorkOrders(await getScope(event)),
    },
    actorOf(event, user),
  )
})
