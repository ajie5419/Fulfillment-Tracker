import { z } from 'zod'
import { updatePart } from '../../services/flow/steps'
import { partFields } from '../../schemas/flow'

const body = z.object(partFields).partial().strict()

export default defineFlowHandler(async (event) => {
  return updatePart(routeId(event), await parseBody(event, body))
})
