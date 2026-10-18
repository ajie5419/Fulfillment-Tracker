import { createPayment, workOrderOfLines } from '../../services/purchases/payments'
import { newPaymentBody } from '../../schemas/purchases'

/** 新建付款申请：关联同一工单的采购行。能看到该工单的人都可以申请，不审批 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newPaymentBody)
  await assertCanSee(event, await workOrderOfLines(input.purchaseLineIds))
  return createPayment(input, user.qmsUserId)
})
