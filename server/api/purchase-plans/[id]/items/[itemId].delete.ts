import { deletePurchasePlanItem, workOrderOfPurchasePlan } from '../../../../services/purchases/plans'
export default defineFlowHandler(async event => {
  const id = routeId(event)
  await assertCanSee(event, await workOrderOfPurchasePlan(id))
  await assertCanOperate(event, 'purchasePlan')
  return deletePurchasePlanItem(id, routeId(event, 'itemId'))
})
