import { z } from 'zod'
import { updateStep } from '../../services/flow/steps'
import { stepFields } from '../../schemas/flow'

const body = z.object(stepFields).partial().strict()

export default defineFlowHandler(async (event) => updateStep(routeId(event), await parseBody(event, body)))
