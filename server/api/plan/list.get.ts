import { z } from 'zod'
import { listPlans } from '../../services/plan/list'

const query = z.object({ closed: z.enum(['0', '1']).optional() })

/** 项目计划列表：可见的在做工单各自的计划状态、节点进度、待确认 / 未分解 / 延误、预计交期；?closed=1 另列出已完工 / 已取消的 */
export default defineFlowHandler(async (event) => {
  const { closed } = parseQuery(event, query)
  return listPlans(scopeWorkOrders(await getScope(event)), await getRoleContext(event), new Date(), { withClosed: closed === '1' })
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestQuery = z.input<typeof query>
