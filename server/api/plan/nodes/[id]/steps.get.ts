import { FlowError } from '../../../../services/flow/errors'
import { nodeTarget } from '../../../../services/plan/plan'
import { stepOptions } from '../../../../services/plan/tasks'

/** "挂工序"弹窗：节点所属工单的全部工序（含已挂在哪个节点） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  const node = await nodeTarget(id)
  if (!node) throw new FlowError('总计划节点不存在')
  return stepOptions(node.workOrderNumber)
})
