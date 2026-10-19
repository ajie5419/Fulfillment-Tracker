import { updateTemplate } from '../../../services/plan/templates'
import { templateBody } from '../../../schemas/plan'

/** 修改总计划模板（整份替换节点；已生成的总计划不受影响）：项目部负责人、管理员 */
export default defineFlowHandler(async (event) => {
  await assertCanOperate(event, 'planTemplate')
  return updateTemplate(routeId(event), await parseBody(event, templateBody))
})
