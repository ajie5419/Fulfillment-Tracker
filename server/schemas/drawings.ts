/** 设计出图任务（R11）接口的 zod 片段。日期一律用 schemas/flow.ts 的 day（拒绝 2026-02-30 这类不存在的日期） */
import { z } from 'zod'
import { day } from './flow'

const id = z.string().min(1).max(191)

const taskFields = {
  /** 关联工件（可多选，可不选：只写部件名称） */
  partIds: z.array(id).max(100, '关联工件最多 100 个'),
  componentName: z.string().trim().min(1, '请填写部件名称').max(191, '部件名称最多 191 字'),
  /** 设计负责人；空 = 技术部负责人 */
  ownerId: z.string().max(64).nullish(),
  planDate: day,
  needsCustomerConfirm: z.boolean(),
  customerPlanDate: day.nullish(),
  note: z
    .string()
    .trim()
    .max(500, '备注最多 500 字')
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
}

export const newTaskBody = z
  .object({
    workOrderNumber: z.string().min(1, '请选择工单').max(64),
    ...taskFields,
    partIds: taskFields.partIds.default([]),
    needsCustomerConfirm: taskFields.needsCustomerConfirm.default(false),
  })
  .strict()

export const patchTaskBody = z
  .object({ ...taskFields, cancelled: z.boolean() })
  .partial()
  .strict()

/** 标记出图 / 录客户确认：日期默认今天 */
export const dateBody = z.object({ date: day.nullish() }).strict()

export const listQuery = z.object({
  workOrderNumber: z.string().max(64).optional(),
  ownerId: z.string().max(64).optional(),
  view: z.enum(['open', 'pending', 'overdue', 'drawn', 'done', 'cancelled', 'all']).optional(),
  q: z.string().max(100).optional(),
  /** 1 = 我的出图任务（我是设计负责人的，不受工单可见范围限制） */
  mine: z.enum(['0', '1']).optional(),
})

export const loadQuery = z.object({ workOrderNumber: z.string().max(64).optional() })
