import { canSeeAmount } from '../../services/auth/permissions'
import { listPayments } from '../../services/purchases/payments'
import { paymentQuery } from '../../schemas/purchases'

/** 付款申请列表（项目和财务看）：按影响排序（卡交期、离需求日近的在前）。只列可见工单上的。
 * 金额只给财务、采购部、领导、项目部负责人、管理员、该工单项目经理，其他人返回 null（权限方案 R13） */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, paymentQuery)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  const ctx = await getRoleContext(event)
  return listPayments(
    { ...q, blocking: q.blocking === '1', workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)), amountVisible: (wo) => canSeeAmount(ctx, wo) },
    actorOf(event, user),
  )
})
