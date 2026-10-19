import { loadThresholds } from '../../services/alerts/config'
import { editorContext, listNodes } from '../../services/kitting/kitting'
import { listQuery } from '../../schemas/kitting'

/**
 * 装配节点列表（含齐套率、缺件清单）+ 统计。指定工单时按节点顺序；不指定时是跨工单视图，按需求日从近到远。
 * 只列可见工单上的；mine=1 时是"我负责的节点"（负责人是我，或没指定负责人而我是生产经理），不受工单可见范围限制。
 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, listQuery)
  const mine = q.mine === '1'
  if (q.workOrderNumber && !mine) await assertCanSee(event, q.workOrderNumber)
  const actor = actorOf(event, user)
  const [t, ctx] = await Promise.all([loadThresholds(), mine ? editorContext(actor) : null])
  return listNodes(
    {
      workOrderNumber: q.workOrderNumber || undefined,
      incompleteOnly: q.incomplete === '1',
      dueSoonOnly: q.dueSoon === '1',
      mine: ctx ? { userId: user.qmsUserId, isProductionHead: ctx.isProductionHead } : undefined,
      visibleWorkOrders: mine ? undefined : scopeWorkOrders(await getScope(event)),
    },
    actor,
    t.W8,
  )
})
