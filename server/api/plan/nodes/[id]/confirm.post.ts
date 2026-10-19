import { confirmNode } from '../../../../services/plan/plan'

/** 确认节点：该节点责任部门负责人、管理员（或手里有这条确认待办的人） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'planConfirm', id)
  return confirmNode(id, user.qmsUserId)
})
