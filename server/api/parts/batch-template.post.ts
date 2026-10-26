import { z } from 'zod'
import { applyTemplateBatch } from '../../services/templates/templates'
import { dayString } from '../../schemas/flow'

const body = z
  .object({
    partIds: z.array(z.string().min(1).max(191)).min(1, '请先勾选工件').max(200, '一次最多 200 个工件'),
    templateId: z.string().min(1).max(191),
    startDate: dayString.nullish(),
  })
  .strict()

/** 工序编排批量套模板：只给还没有工序的工件套，已有工序链的跳过。权限同单个工件（route） */
export default defineFlowHandler(async (event, user) => {
  const b = await parseBody(event, body)
  await assertBatchParts(event, b.partIds)
  return applyTemplateBatch(b.partIds, b.templateId, user.qmsUserId, b.startDate)
})
