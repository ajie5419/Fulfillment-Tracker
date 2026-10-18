import { undoArrival } from '../../../services/purchases/purchases'

/** 撤销到货（确认错了），回到未到货 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  return undoArrival(id)
})
