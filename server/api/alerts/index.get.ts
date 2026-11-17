import { z } from 'zod'
import { ALERT_RULES } from '../../../shared/alert-rules'
import { listAlerts } from '../../services/alerts/reminders'

const query = z.object({
  rule: z.enum(ALERT_RULES).optional(),
  level: z.enum(['REMIND', 'YELLOW', 'RED']).optional(),
  workOrderNumber: z.string().max(64).optional(),
})

/** Responsibility scope is mandatory; query filters can only narrow it. */
export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listAlerts({
    ...q,
    workOrderNumber: q.workOrderNumber || undefined,
    viewer: actorOf(event, user),
  })
})

/** 客户端请求契约（仅类型导出）。 */
export type RequestQuery = z.input<typeof query>
