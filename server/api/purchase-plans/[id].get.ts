import { getPurchasePlan, workOrderOfPurchasePlan } from '../../services/purchases/plans'
export default defineFlowHandler(async event => {
  const id = routeId(event)
  await assertCanSee(event, await workOrderOfPurchasePlan(id))
  return getPurchasePlan(id)
})
