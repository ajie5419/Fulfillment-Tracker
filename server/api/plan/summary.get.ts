import { listPlans } from '../../services/plan/list'

/** 在做工单的完整预测汇总，与分页明细独立。 */
export default defineFlowHandler(async (event) => {
  const result = await listPlans(scopeWorkOrders(await getScope(event)), await getRoleContext(event))
  return result.summary
})
