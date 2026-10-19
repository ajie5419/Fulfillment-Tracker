import { planOptions } from '../../services/plan/plan'
import { woQuery } from '../../schemas/plan'

/** 部门记录弹窗的"所属总计划节点"下拉：同一工单的节点，及是否已发布（已发布时新建必选）。能看到该工单的人 */
export default defineFlowHandler(async (event) => {
  const { workOrderNumber } = parseQuery(event, woQuery)
  await assertCanSee(event, workOrderNumber)
  return planOptions(workOrderNumber)
})
