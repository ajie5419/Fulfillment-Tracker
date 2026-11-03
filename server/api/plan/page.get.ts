import { z } from 'zod'
import { paginationFields, safePageOffset } from '../../../shared/pagination'
import { listPlansPage } from '../../services/plan/list'

const query = z.object({ ...paginationFields, closed: z.enum(['0', '1']).optional() }).superRefine(safePageOffset)
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  return listPlansPage(scopeWorkOrders(await getScope(event)), await getRoleContext(event), new Date(), { ...q, withClosed: q.closed === '1' })
})
export type RequestQuery = z.input<typeof query>
