import { updateNode } from '../../../services/plan/plan'
import { patchNodeBody } from '../../../schemas/plan'

/** 改节点（名称、责任部门、计划日、顺序、备注；发布后改计划日要写原因）：该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'plan', id)
  return updateNode(id, await parseBody(event, patchNodeBody), user.qmsUserId)
})
