import { z } from 'zod'
import { applyTemplate } from '../../../services/templates/templates'
import { dayString } from '../../../schemas/flow'

const body = z
  .object({
    templateId: z.string().min(1).max(191),
    startDate: dayString.nullish(),
  })
  .strict()

/** 给还没有工序的工件套用模板（跟着工件编辑权限走） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  const { templateId, startDate } = await parseBody(event, body)
  return applyTemplate(id, templateId, user.qmsUserId, startDate)
})
