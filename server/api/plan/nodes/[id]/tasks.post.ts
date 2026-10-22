import { createPlanTask } from '../../../../services/plan/tasks'
import { newTaskBody } from '../../../../schemas/plan'

/** 在节点下分解"其他任务"（给负责人发待办）：该节点责任部门的人、该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanNode(event, id)
  await assertCanOperatePlanNode(event, 'planTask', id)
  return createPlanTask(id, await parseBody(event, newTaskBody), user.qmsUserId)
})
