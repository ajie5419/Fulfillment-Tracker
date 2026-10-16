import { z } from 'zod'
import { updatePart } from '../../services/flow/steps'
import { partFields } from '../../schemas/flow'

const body = z.object(partFields).partial().strict()

export default defineFlowHandler(async (event) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  return updatePart(id, await parseBody(event, body))
})
