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

/** 发出登记（厂外外协） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  return sendStep({ ...input, stepId: routeId(event), actorId: user.qmsUserId })
})
