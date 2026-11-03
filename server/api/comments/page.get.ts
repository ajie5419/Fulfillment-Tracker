import { z } from 'zod'
import { paginationFields, safePageOffset } from '../../../shared/pagination'
import { COMMENT_REFS, listCommentsPage, resolveRef } from '../../services/comments/comments'
import { prisma } from '../../utils/prisma'

const query = z.object({ ...paginationFields, refType: z.enum(COMMENT_REFS), refId: z.string().min(1).max(64) }).superRefine(safePageOffset)
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  const ref = await resolveRef(prisma, q.refType, q.refId)
  if (!ref) return { rows: [], total: 0, page: q.page, pageSize: q.pageSize }
  await assertCanSee(event, ref.workOrderNumber)
  return listCommentsPage(q.refType, q.refId, q)
})
export type RequestQuery = z.input<typeof query>
