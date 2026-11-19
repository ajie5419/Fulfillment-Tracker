import { z } from 'zod'
import { DIRECTORY_PAGE_SIZE, DIRECTORY_SEARCH_LIMIT } from '../../shared/board-directory'
import { paginationFields, safePageOffset } from '../../shared/pagination'
import { listBoardDirectory } from '../services/plan/list'

const query = z.object({
  ...paginationFields,
  pageSize: paginationFields.pageSize.default(DIRECTORY_PAGE_SIZE),
  q: z.string().trim().max(DIRECTORY_SEARCH_LIMIT).default(''),
  delivery: z.enum(['all', 'late', 'soon']).default('all'),
  mine: z.enum(['0', '1']).default('0'),
}).superRefine(safePageOffset)

export default defineFlowHandler(async event => {
  const options = parseQuery(event, query)
  return listBoardDirectory(scopeWorkOrders(await getScope(event)), await getRoleContext(event), options)
})
export type RequestQuery = z.input<typeof query>
