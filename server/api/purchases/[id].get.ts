import { getLine } from '../../services/purchases/purchases'

/** 采购行详情（手机到货确认页） */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  return getLine(id)
})
