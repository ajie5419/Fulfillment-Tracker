import { z } from 'zod'
import { COMMENT_REFS, listComments, resolveRef } from '../../services/comments/comments'
import { prisma } from '../../utils/prisma'

const query = z.object({ refType: z.enum(COMMENT_REFS), refId: z.string().min(1).max(64) })

/** 某个工件 / 采购行的留言：能看到该工单的人都能看 */
export default defineFlowHandler(async (event) => {
  const q = parseQuery(event, query)
  const ref = await resolveRef(prisma, q.refType, q.refId)
  if (ref) await assertCanSee(event, ref.workOrderNumber)
  return listComments(q.refType, q.refId)
})
