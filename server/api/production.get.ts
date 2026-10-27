import { z } from 'zod'
import { listProduction } from '../services/flow/workshop'

const query = z.object({
  wo: z.string().max(64).optional(),
  supplierId: z.string().max(64).optional(),
  /** 1 = 只看我的：本人负责的 + 本人当班组长的班组的自制工序 */
  mine: z.enum(['1', '0']).optional(),
})

/** 生产调度（电脑端）/ 手机"生产"页签：跨工单的工序行（可以开工、加工中、在外、卡住、近 7 天完成）+ 没排工序的工件数；只列可见工单 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  const visibleWorkOrders = scopeWorkOrders(await getScope(event))
  if (q.wo) await assertCanSee(event, q.wo)
  return listProduction({
    workOrderNumber: q.wo || undefined,
    supplierId: q.supplierId || undefined,
    mine: q.mine === '1' ? { userId: user.qmsUserId, teamIds: (await getRoleContext(event)).leadOf ?? [] } : undefined,
    visibleWorkOrders,
  })
})
