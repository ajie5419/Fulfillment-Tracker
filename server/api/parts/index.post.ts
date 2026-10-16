import { z } from 'zod'
import { createPart } from '../../services/flow/steps'
import { partFields } from '../../schemas/flow'

const body = z.object({ workOrderNumber: z.string().min(1).max(64), ...partFields }).strict()

export default defineFlowHandler(async (event, user) => {
  const { workOrderNumber, ...input } = await parseBody(event, body)
  assertCanSee(user, workOrderNumber)
  return createPart(workOrderNumber, input)
})
