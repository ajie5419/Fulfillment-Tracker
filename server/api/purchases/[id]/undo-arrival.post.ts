import { undoArrival } from '../../../services/purchases/purchases'

/** 撤销到货（确认错了），回到未到货：采购部、该工单项目经理、管理员 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  await assertCanOperatePurchase(event, id)
  return undoArrival(id)
})
