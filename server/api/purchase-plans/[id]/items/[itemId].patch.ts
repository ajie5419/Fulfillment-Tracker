import { planItemBody } from '../../../../schemas/purchase-plans'
import { savePurchasePlanItem, workOrderOfPurchasePlan } from '../../../../services/purchases/plans'
export default defineFlowHandler(async event => {
  const id = routeId(event)
  await assertCanSee(event, await workOrderOfPurchasePlan(id))
  await assertCanOperate(event, 'purchasePlan')
  return savePurchasePlanItem(id, routeId(event, 'itemId'), await parseBody(event, planItemBody))
})
