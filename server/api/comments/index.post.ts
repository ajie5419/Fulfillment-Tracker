import { z } from 'zod'
import { COMMENT_REFS, MAX_COMMENT, addComment, resolveRef } from '../../services/comments/comments'
import { prisma } from '../../utils/prisma'

const body = z
  .object({
    refType: z.enum(COMMENT_REFS),
    refId: z.string().min(1).max(64),
    body: z.string().max(MAX_COMMENT + 100),
    mentionIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict()

/** 写留言、@人：能看到该工单的人都能写（不分部门，跨部门沟通用） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  const ref = await resolveRef(prisma, input.refType, input.refId)
  if (ref) await assertCanSee(event, ref.workOrderNumber)
  return addComment(input, user.qmsUserId, adminIds(event))
})
