import { planHeadBody } from '../../schemas/purchase-plans'
import { updatePurchasePlan, workOrderOfPurchasePlan } from '../../services/purchases/plans'
export default defineFlowHandler(async event => {
  const id = routeId(event)
  await assertCanSee(event, await workOrderOfPurchasePlan(id))
  await assertCanOperate(event, 'purchasePlan')
  return updatePurchasePlan(id, await parseBody(event, planHeadBody))
})
