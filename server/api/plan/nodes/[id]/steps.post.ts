import { FlowError } from '../../../../services/flow/errors'
import { nodeTarget } from '../../../../services/plan/plan'
import { linkStepsToNode } from '../../../../services/plan/tasks'
import { linkStepsBody } from '../../../../schemas/plan'

/** 把同一工单的工序挂到这个节点：生产部、外协专员、该工单项目经理、管理员（与编辑工序同一权限） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  const node = await nodeTarget(id)
  if (!node) throw new FlowError('总计划节点不存在')
  await assertCanOperate(event, 'route', { workOrderNumber: node.workOrderNumber })
  const { stepIds } = await parseBody(event, linkStepsBody)
  return linkStepsToNode(id, stepIds)
})
