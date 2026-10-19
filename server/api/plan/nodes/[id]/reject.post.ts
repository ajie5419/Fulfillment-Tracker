import { rejectNode } from '../../../../services/plan/plan'
import { rejectBody } from '../../../../schemas/plan'

/** 退回节点（写原因，提醒项目经理）：该节点责任部门负责人、管理员（或手里有这条确认待办的人） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'planConfirm', id)
  const { reason } = await parseBody(event, rejectBody)
  return rejectNode(id, reason, user.qmsUserId)
})
