import { z } from 'zod'
import { sendStep } from '../../../services/flow/flow'
import { day, source } from '../../../schemas/flow'

const body = z
  .object({
    supplierId: z.string().max(64).nullish(),
    promisedReturnDate: day,
    qty: z.number().int().min(1).optional(),
    source,
  })
  .strict()

/** 发出登记（厂外外协）：生产部、外协专员、该工序责任人、管理员 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  const stepId = routeId(event)
  await assertCanSeeStep(event, stepId)
  await assertCanOperateStep(event, 'stepAction', stepId)
  return sendStep({ ...input, stepId, actorId: user.qmsUserId })
})
