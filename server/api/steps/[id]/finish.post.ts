import { z } from 'zod'
import { finishStep } from '../../../services/flow/finish'
import { source } from '../../../schemas/flow'

const body = z
  .object({
    source,
    /** 本次完成数量；不填 = 剩余全部 */
    qty: z.number().int().min(0).max(100000).optional(),
    /** 数量不够时：剩下的还在做 / 报废了 */
    rest: z.enum(['CONTINUE', 'SCRAP']).optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

/** 完工（自制、厂内外协），可部分完工或报废，见 services/flow/finish.ts：生产部、外协专员、该工序责任人、管理员 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  const stepId = routeId(event)
  await assertCanSeeStep(event, stepId)
  await assertCanOperateStep(event, 'stepAction', stepId)
  return finishStep({ ...input, stepId, actorId: user.qmsUserId })
})
