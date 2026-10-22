import { FlowError } from '../../../../services/flow/errors'
import { nodeTarget } from '../../../../services/plan/plan'
import { stepOptions } from '../../../../services/plan/tasks'

/** "挂工序"弹窗：节点所属工单的全部工序（含已挂在哪个节点）；权限同挂工序（route） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  const node = await nodeTarget(id)
  if (!node) throw new FlowError('总计划节点不存在')
  // 列出整张工单的工序，与"挂工序"同一权限（只因转交确认待办而看得到节点的人不能借此看全部工序）
  await assertCanOperate(event, 'route', { workOrderNumber: node.workOrderNumber })
  return stepOptions(node.workOrderNumber)
})
