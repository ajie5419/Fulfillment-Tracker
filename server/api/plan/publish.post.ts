import { publishPlan } from '../../services/plan/plan'
import { woBody } from '../../schemas/plan'

/** 发布总计划（锁基线、请各部门确认）：该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const { workOrderNumber } = await parseBody(event, woBody)
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'plan', { workOrderNumber })
  return publishPlan(workOrderNumber, user.qmsUserId)
})
