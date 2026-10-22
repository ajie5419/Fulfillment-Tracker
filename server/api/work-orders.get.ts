import { z } from 'zod'
import { ACTIVE_WO_WHERE } from '../services/workorder/active'

const query = z.object({ closed: z.enum(['0', '1']).optional() })

/**
 * 工单列表（QMS 副本），交期近的在前；只列当前用户可见的（项目经理只看自己负责的）。
 * 默认只列在做的工单（没删除、没完工、没取消）；?closed=1 连已完工 / 已取消一起列（已删除的始终不列）。
 */
export default defineFlowHandler(async (event) => {
  const visible = scopeWorkOrders(await getScope(event))
  const withClosed = parseQuery(event, query).closed === '1'
  return prisma.qmsWorkOrder.findMany({
    where: { ...(withClosed ? { isDeleted: false } : ACTIVE_WO_WHERE), ...(visible ? { workOrderNumber: { in: visible } } : {}) },
    orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    select: { workOrderNumber: true, customerName: true, projectName: true, deliveryDate: true, status: true, quantity: true },
  })
})
