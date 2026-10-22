import { completePlanTask } from '../../../../services/plan/tasks'
import { completeBody } from '../../../../schemas/plan'

/** 其他任务标完成（日期默认今天）：任务负责人，或该节点责任部门的人、该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePlanTask(event, id)
  await assertCanOperatePlanTask(event, id, { allowOwner: true })
  const { date } = await parseBody(event, completeBody)
  return completePlanTask(id, date, user.qmsUserId)
})
