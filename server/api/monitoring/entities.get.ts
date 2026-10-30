import { z } from 'zod'
import { canSeeOverview } from '../../services/auth/permissions'
import { FlowForbidden } from '../../services/flow/errors'
import { listMonitoredEntities } from '../../services/monitoring/status'

const query = z.object({
  entityType: z.enum(['step', 'part']).optional(),
  status: z.enum(['PENDING', 'OUT', 'IN_PROGRESS', 'BLOCKED', 'ACTIVE']).optional(),
  level: z.enum(['GREEN', 'YELLOW', 'RED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

/** 在制分布下钻：与汇总同源，包含尚未轮到开工的工序。 */
export default defineFlowHandler(async (event) => {
  if (!canSeeOverview(await getRoleContext(event))) throw new FlowForbidden('状态监控仅领导、项目部负责人和管理员可以查看')
  return listMonitoredEntities(parseQuery(event, query))
})
