import { planListQuery } from '../../schemas/purchase-plans'
import { listPurchasePlans } from '../../services/purchases/plans'
export default defineFlowHandler(async event => {
  const q = parseQuery(event, planListQuery)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  return listPurchasePlans({ ...q, visibleWorkOrders: scopeWorkOrders(await getScope(event)) })
})
