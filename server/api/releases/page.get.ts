import { z } from 'zod'
import { paginationFields, safePageOffset } from '../../../shared/pagination'
import { releaseType } from '../../schemas/releases'
import { listReleasesPage } from '../../services/releases/queries'

const query = z.object({
  ...paginationFields,
  workOrderNumber: z.string().max(64).optional(),
  type: releaseType.optional(),
  progress: z.enum(['PENDING', 'REJECTED', 'VOID', 'MINE_PENDING']).optional(),
  mine: z.enum(['issued', 'received']).optional(),
}).superRefine(safePageOffset)

export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listReleasesPage({ ...q, workOrderNumber: q.workOrderNumber || undefined, visibleWorkOrders: scopeWorkOrders(await getScope(event)) }, user.qmsUserId, q)
})
export type RequestQuery = z.input<typeof query>
