import { z } from 'zod'
import { manualReturn } from '../../../services/flow/flow'
import { source } from '../../../schemas/flow'

const body = z.object({ qty: z.number().int().min(1, '数量至少为 1').max(100000), source }).strict()

/** 补登返厂（QMS 漏报时的兜底） */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  return manualReturn({ ...input, stepId: routeId(event), actorId: user.qmsUserId })
})
