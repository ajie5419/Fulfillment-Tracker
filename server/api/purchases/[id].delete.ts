import { deleteLine } from '../../services/purchases/purchases'

/** 删除采购行（录错了）：采购部、该工单项目经理、管理员；关联了付款申请的不能删 */
export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePurchase(event, id)
  await assertCanOperatePurchase(event, id)
  return deleteLine(id)
})
