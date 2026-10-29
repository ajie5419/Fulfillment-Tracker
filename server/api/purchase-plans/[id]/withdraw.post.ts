import { changePurchasePlanStatus, workOrderOfPurchasePlan } from '../../../services/purchases/plans'
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSee(event, await workOrderOfPurchasePlan(id))
  await assertCanOperate(event, 'purchasePlan')
  return changePurchasePlanStatus(id, 'withdraw', user.qmsUserId)
})
