import { z } from 'zod'
import { listAlerts } from '../../services/alerts/reminders'

const query = z.object({
  rule: z.enum(['W1', 'W2', 'W3']).optional(),
  level: z.enum(['REMIND', 'YELLOW', 'RED']).optional(),
  workOrderNumber: z.string().max(64).optional(),
})

/** 活动中的预警，可按规则、级别、工单筛选 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  return listAlerts({ ...q, workOrderNumber: q.workOrderNumber || undefined })
})
