import { z } from 'zod'
import { createIssue, MAX_PHOTOS } from '../../services/issues/issues'
import { day } from '../../schemas/flow'
import { category } from '../../schemas/issues'

const body = z
  .object({
    workOrderNumber: z.string().min(1, '请选择工单').max(64),
    partId: z.string().max(191).nullish(),
    category,
    title: z.string().trim().min(1, '请填写标题').max(100, '标题最多 100 字').optional(),
    description: z.string().trim().min(1, '请填写一句话描述').max(500, '描述最多 500 字'),
    photoIds: z.array(z.string().regex(/^[a-f0-9]{32}$/, '照片无效')).max(MAX_PHOTOS, `照片最多 ${MAX_PHOTOS} 张`).default([]),
    dueDate: day.nullish(),
    responsibleSupplierId: z.string().max(64).nullish(),
  })
  .strict()

/** 上报异常（手工）：按分类默认责任部门和责任人 */
export default defineFlowHandler(async (event, user) => {
  const input = await parseBody(event, body)
  await assertCanSee(event, input.workOrderNumber)
  const issue = await createIssue(input, user.qmsUserId)
  return { id: issue.id, issueNo: issue.issueNo }
})
