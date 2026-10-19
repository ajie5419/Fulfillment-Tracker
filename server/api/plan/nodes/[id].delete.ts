import { deleteNode } from '../../../services/plan/plan'
import { deleteNodeBody } from '../../../schemas/plan'

/** 删节点（挂在上面的部门记录变成未挂；发布后要写原因）：该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'plan', id)
  const { reason } = await parseBody(event, deleteNodeBody)
  return deleteNode(id, reason, user.qmsUserId)
})
