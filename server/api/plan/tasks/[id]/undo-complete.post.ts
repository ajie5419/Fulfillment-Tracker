import { undoCompletePlanTask } from '../../../../services/plan/tasks'

/** 其他任务撤销完成（重新给负责人发待办）：任务负责人，或该节点责任部门的人、该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePlanTask(event, id)
  await assertCanOperatePlanTask(event, id, { allowOwner: true })
  return undoCompletePlanTask(id)
})
