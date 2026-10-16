import { z } from 'zod'
import { resolveUnmatched } from '../../../services/flow/match'

const body = z.object({ stepId: z.string().min(1, '请选择要关联的步骤').max(191) }).strict()

/** 人工关联到某个步骤 */
export default defineFlowHandler(async (event, user) => {
  const { stepId } = await parseBody(event, body)
  return resolveUnmatched(routeId(event), stepId, user.qmsUserId)
})
