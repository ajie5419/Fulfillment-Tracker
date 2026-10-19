import { z } from 'zod'
import { finishStep } from '../../../services/flow/flow'
import { source } from '../../../schemas/flow'

const body = z.object({ source }).strict()

/** 完工（自制、厂内外协），效果等同全部返厂：生产部、外协专员、该工序责任人、管理员 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  const stepId = routeId(event)
  await assertCanSeeStep(event, stepId)
  await assertCanOperateStep(event, 'stepAction', stepId)
  return finishStep({ ...input, stepId, actorId: user.qmsUserId })
})
