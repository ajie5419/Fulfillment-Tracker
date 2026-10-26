import { z } from 'zod'
import { batchUpdateSteps } from '../../services/flow/steps'
import { stepFields } from '../../schemas/flow'

const body = z
  .object({
    partIds: z.array(z.string().min(1).max(191)).min(1, '请先勾选工件').max(200, '一次最多 200 个工件'),
    /** 只改这道工序；不传 = 全部没完成的工序 */
    processId: z.string().max(64).nullish(),
    set: z
      .object({
        ownerId: stepFields.ownerId,
        supplierId: stepFields.supplierId,
        planStartDate: stepFields.planStartDate,
        dueDate: stepFields.dueDate,
        planNodeId: stepFields.planNodeId,
      })
      .partial()
      .strict()
      .refine((s) => Object.values(s).some((v) => v !== undefined), '请至少填一项要设置的内容'),
  })
  .strict()

/** 工序编排批量设负责人、班组 / 外协厂、日期、总计划节点（一个事务，规则同单道修改）。权限同单个工件（route） */
export default defineFlowHandler(async (event) => {
  const b = await parseBody(event, body)
  await assertBatchParts(event, b.partIds)
  return batchUpdateSteps({ partIds: b.partIds, processId: b.processId ?? null, set: b.set })
})
