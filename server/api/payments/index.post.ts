import { createPayment, workOrderOfLines } from '../../services/purchases/payments'
import { newPaymentBody } from '../../schemas/purchases'

/** 新建付款申请：关联同一工单的采购行。采购部、该工单项目经理、管理员可以申请，不审批 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, newPaymentBody)
  const workOrderNumber = await workOrderOfLines(input.purchaseLineIds)
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'payment', { workOrderNumber })
  return createPayment(input, user.qmsUserId)
})
