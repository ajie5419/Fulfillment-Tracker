import { z } from 'zod'
import { releaseStats } from '../../services/releases/releases'
import { releaseType } from '../../schemas/releases'

const query = z.object({
  workOrderNumber: z.string().max(64).optional(),
  type: releaseType.optional(),
  mine: z.enum(['issued', 'received']).optional(),
})

/** 发放签收页顶部统计卡：全部、有人未签收、有拒收、待我签收。范围与 GET /api/releases 相同（可见工单上的，加上发给我的 / 我发出的） */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return releaseStats({ ...q, workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)) }, user.qmsUserId)
})
