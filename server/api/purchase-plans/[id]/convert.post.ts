import { convertPlanBody } from '../../../schemas/purchase-plans'
import { convertPurchasePlan, workOrderOfPurchasePlan } from '../../../services/purchases/plans'
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSee(event, await workOrderOfPurchasePlan(id))
  await assertCanOperate(event, 'purchasePlanConvert')
  return convertPurchasePlan(id, (await parseBody(event, convertPlanBody)).itemIds, user.qmsUserId)
})
