import { z } from 'zod'
import { startStep } from '../../../services/flow/flow'
import { source } from '../../../schemas/flow'

const body = z.object({ source }).strict()

/** 开工（自制、厂内外协） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  return startStep({ ...input, stepId: routeId(event), actorId: user.qmsUserId })
})
