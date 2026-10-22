import { deletePlanTask } from '../../../services/plan/tasks'

/** 删其他任务（待办作废）：该节点责任部门的人、该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanTask(event, id)
  await assertCanOperatePlanTask(event, id)
  return deletePlanTask(id)
})
