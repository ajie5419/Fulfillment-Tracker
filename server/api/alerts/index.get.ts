import { z } from 'zod'
import { listAlerts } from '../../services/alerts/reminders'

const query = z.object({
  rule: z.enum(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9']).optional(),
  level: z.enum(['REMIND', 'YELLOW', 'RED']).optional(),
  workOrderNumber: z.string().max(64).optional(),
})

/** 活动中的预警（及已转异常的），可按规则、级别、工单筛选；只列可见工单的，并标出当前用户能否"转异常" */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listAlerts({
    ...q,
    workOrderNumber: q.workOrderNumber || undefined,
    visibleWorkOrders: scopeWorkOrders(await getScope(event)),
    viewer: actorOf(event, user),
  })
})
