import { z } from 'zod'
import { applyTemplate } from '../../../services/templates/templates'

const body = z
  .object({
    templateId: z.string().min(1).max(191),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').nullish(),
  })
  .strict()

/** 给还没有工序的工件套用模板（跟着工件编辑权限走） */
export default defineFlowHandler(async (event, user) => {
  const id = routeId(event)
  await assertCanSeePart(event, id)
  const { templateId, startDate } = await parseBody(event, body)
  return applyTemplate(id, templateId, user.qmsUserId, startDate)
})
