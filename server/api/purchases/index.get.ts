import { canSeeAmount } from '../../services/auth/permissions'
import { listLines } from '../../services/purchases/purchases'
import { listQuery } from '../../schemas/purchases'

/** 关键物料采购行列表 + 统计（缺料、无承诺日、延误按原因分：付款原因 / 管理原因）。只列可见工单上的；关联付款的金额按权限给（看不到的为 null） */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, listQuery)
  if (q.workOrderNumber) await assertCanSee(event, q.workOrderNumber)
  const ctx = await getRoleContext(event)
  return listLines({
    ...q,
    workOrderNumber: q.workOrderNumber || undefined,
    partId: q.partId || undefined,
    visibleWorkOrders: scopeWorkOrders(await getScope(event)),
    amountVisible: (wo) => canSeeAmount(ctx, wo),
  })
})
