import { createTemplate } from '../../../services/plan/templates'
import { templateBody } from '../../../schemas/plan'

/** 新建总计划模板：项目部负责人、管理员 */
export default defineFlowHandler(async (event, user) => {
  await assertCanOperate(event, 'planTemplate')
  return createTemplate(await parseBody(event, templateBody), user.qmsUserId)
})
