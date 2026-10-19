import { generateFromTemplate } from '../../services/plan/plan'
import { generateBody } from '../../schemas/plan'

/** 按模板生成总计划（草稿时可以重新生成，整份替换）：该工单项目经理、项目部、管理员 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, generateBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'plan', { workOrderNumber: input.workOrderNumber })
  return generateFromTemplate(input.workOrderNumber, input.templateId, user.qmsUserId)
})
