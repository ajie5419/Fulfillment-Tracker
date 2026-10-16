import { z } from 'zod'
import { moveStep } from '../../../services/flow/steps'

const body = z.object({ direction: z.enum(['up', 'down']) }).strict()

export default defineFlowHandler(async (event) => {
  const { direction } = await parseBody(event, body)
  return moveStep(routeId(event), direction)
})
