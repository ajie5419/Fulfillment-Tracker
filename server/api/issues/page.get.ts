import { z } from 'zod'
import { paginationFields, safePageOffset } from '../../../shared/pagination'
import { category } from '../../schemas/issues'
import { myDepartmentIds } from '../../services/issues/issues'
import { listIssuesPage } from '../../services/issues/queries'

const query = z.object({
  ...paginationFields,
  status: z.enum(['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED', 'UNCLOSED']).optional(),
  category: category.optional(), workOrderNumber: z.string().max(64).optional(),
  dept: z.enum(['0', '1']).optional(), mine: z.enum(['responsible', 'reported', 'todo']).optional(),
  overdue: z.enum(['0', '1']).optional(),
}).superRefine(safePageOffset)

export default defineFlowHandler(async (event, user) => {
  const q = parseQuery(event, query)
  return listIssuesPage({ ...q,
    workOrderNumber: q.workOrderNumber || undefined,
    deptIds: q.dept === '1' ? await myDepartmentIds(user.qmsUserId) : undefined,
    overdue: q.overdue === '1', visibleWorkOrders: scopeWorkOrders(await getScope(event)),
  }, actorOf(event, user), new Date(), q)
})
export type RequestQuery = z.input<typeof query>
