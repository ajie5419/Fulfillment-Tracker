import { z } from 'zod'
import { updateStep } from '../../services/flow/steps'
import { stepFields } from '../../schemas/flow'

const body = z.object(stepFields).partial().strict()

export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeeStep(event, id)
  return updateStep(id, await parseBody(event, body))
})
