import { z } from 'zod'
import { listReleases } from '../../services/releases/releases'
import { releaseType } from '../../schemas/releases'

const query = z.object({
  workOrderNumber: z.string().max(64).optional(),
  type: releaseType.optional(),
  progress: z.enum(['PENDING', 'REJECTED', 'VOID']).optional(),
  mine: z.enum(['issued', 'received']).optional(),
})

/** 发放单列表：可见工单上的，加上发给我的 */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listReleases({ ...q, workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)) }, user.qmsUserId)
})
