import { updatePlanTask } from '../../../services/plan/tasks'
import { patchTaskBody } from '../../../schemas/plan'

/** 改其他任务（名称、负责人、计划完成日、备注）：该节点责任部门的人、该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanTask(event, id)
  await assertCanOperatePlanTask(event, id)
  return updatePlanTask(id, await parseBody(event, patchTaskBody))
})
