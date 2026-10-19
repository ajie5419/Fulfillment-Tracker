import { completeNode } from '../../../../services/plan/plan'
import { completeBody } from '../../../../schemas/plan'

/** 手动标记节点完成（日期默认今天）：该节点责任部门的人、该工单项目经理、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'planNodeDone', id)
  const { date } = await parseBody(event, completeBody)
  return completeNode(id, date, user.qmsUserId)
})
