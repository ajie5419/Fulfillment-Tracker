import { canSeeAmount } from '../../services/auth/permissions'
import { getLine } from '../../services/purchases/purchases'

/** 采购行详情（手机到货确认页）；关联付款的金额按权限给（看不到的为 null） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  const ctx = await getRoleContext(event)
  return getLine(id, new Date(), (wo) => canSeeAmount(ctx, wo))
})
