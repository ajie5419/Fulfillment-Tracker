import { deptPlan } from '../../services/plan/dept'
import { deptPlanQuery } from '../../schemas/plan'

/** 部门计划：本部门在已发布项目计划里负责的末级节点（待接收 / 执行中 / 已完成）、分解的任务、统计 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, deptPlanQuery)
  return deptPlan(await getRoleContext(event), scopeWorkOrders(await getScope(event)), q)
})
