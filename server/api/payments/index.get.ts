import { listPayments } from '../../services/purchases/payments'
import { paymentQuery } from '../../schemas/purchases'

/** 付款申请列表（项目和财务看）：按影响排序（卡交期、离需求日近的在前）。只列可见工单上的 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, paymentQuery)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  return listPayments({ ...q, workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)) }, actorOf(event, user))
})
