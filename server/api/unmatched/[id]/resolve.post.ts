import { z } from 'zod'
import { resolveUnmatched } from '../../../services/flow/match'
import { syncNonconforming } from '../../../services/issues/nonconforming'

const body = z.object({ stepId: z.string().min(1, '请选择要关联的步骤').max(191) }).strict()

/** 人工关联到某个步骤。关联后立即跑一轮 QMS 不合格转异常（报检已判不合格时马上生成异常） */
export default defineFlowHandler(async (event, user) => {
  const { stepId } = await parseBody(event, body)
  const id = routeId(event)
  await assertCanSeeInspection(event, id)
  await assertCanSeeStep(event, stepId)
  const r = await resolveUnmatched(id, stepId, user.qmsUserId)
  await syncNonconforming()
  return r
})
