import { z } from 'zod'
import { addStep } from '../../../services/flow/steps'
import { stepFields } from '../../../schemas/flow'

const body = z.object(stepFields).strict()

/** 在工序链末尾加一道 */
export default defineFlowHandler(async (event, user) => {
  return addStep(routeId(event), await parseBody(event, body), user.qmsUserId)
})
