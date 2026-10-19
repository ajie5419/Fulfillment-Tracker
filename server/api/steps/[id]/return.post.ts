import { z } from 'zod'
import { manualReturn } from '../../../services/flow/flow'
import { source } from '../../../schemas/flow'

const body = z.object({ qty: z.number().int().min(1, '数量至少为 1').max(100000), source }).strict()

/** 补登返厂（QMS 漏报时的兜底）：生产部、外协专员、该工序责任人、管理员。QMS 报检自动匹配不经过这里 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  const stepId = routeId(event)
  await assertCanSeeStep(event, stepId)
  await assertCanOperateStep(event, 'stepAction', stepId)
  return manualReturn({ ...input, stepId, actorId: user.qmsUserId })
})
