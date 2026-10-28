import { purchaseOptionsQuery } from '../../schemas/purchases'
import { listLineOptions } from '../../services/purchases/purchases'

export default defineFlowHandler(async (event) => {
  const query = parseQuery(event, purchaseOptionsQuery)
  await assertCanSee(event, query.workOrderNumber)
  return listLineOptions({ ...query, visibleWorkOrders: scopeWorkOrders(await getScope(event)) })
})
