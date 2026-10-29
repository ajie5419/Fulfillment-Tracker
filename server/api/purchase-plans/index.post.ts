import { newPlanBody } from '../../schemas/purchase-plans'
import { createPurchasePlan } from '../../services/purchases/plans'
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newPlanBody)
  await assertCanSee(event, input.workOrderNumber)
  await assertCanOperate(event, 'purchasePlan')
  return createPurchasePlan(input, user.qmsUserId)
})
