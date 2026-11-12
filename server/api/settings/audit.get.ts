import { z } from 'zod'
import { listAudit } from '../../services/audit/query'

const query = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  requestId: z.string().uuid().optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(191).optional(),
}).strict()

export default defineAdminHandler(async event => listAudit(parseQuery(event, query)))
