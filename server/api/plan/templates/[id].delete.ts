import { deleteTemplate } from '../../../services/plan/templates'

/** 删除总计划模板（已生成的总计划不受影响）：项目部负责人、管理员 */
export default defineFlowHandler(async (event) => {
  await assertCanOperate(event, 'planTemplate')
  return deleteTemplate(routeId(event))
})
