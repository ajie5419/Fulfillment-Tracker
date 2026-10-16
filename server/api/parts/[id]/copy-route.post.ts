import { z } from 'zod'
import { copyRoute } from '../../../services/flow/steps'

const body = z.object({ fromPartId: z.string().min(1).max(191) }).strict()

/** 从另一个工件复制工序链，追加到末尾 */
export default defineFlowHandler(async (event, user) => {
  const { fromPartId } = await parseBody(event, body)
  const id = routeId(event)
  await assertCanSeePart(event, id)
  await assertCanSeePart(event, fromPartId)
  return copyRoute(id, fromPartId, user.qmsUserId)
})
