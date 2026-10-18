/** 齐套（R12）接口的 zod 片段。日期一律用 schemas/flow.ts 的 day（拒绝 2026-02-30 这类不存在的日期） */
import { z } from 'zod'
import { day } from './flow'

const id = z.string().min(1).max(191)

const nodeFields = {
  name: z.string().trim().min(1, '请填写节点名称').max(191, '节点名称最多 191 字'),
  needDate: day,
  /** 节点负责人；空 = 生产经理（生产部负责人） */
  ownerId: z.string().max(64).nullish(),
  note: z
    .string()
    .trim()
    .max(500, '备注最多 500 字')
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
  /** 排序号：小的在前；不填 = 排在该工单最后 */
  sortOrder: z.number().int().min(-100000).max(100000).nullish(),
  /** 需要的工件（同一工单，可多选） */
  partIds: z.array(id).max(300, '工件最多 300 个'),
  /** 需要的关键物料（同一工单，可多选） */
  purchaseIds: z.array(id).max(300, '关键物料最多 300 项'),
}

export const newNodeBody = z
  .object({
    workOrderNumber: z.string().min(1, '请选择工单').max(64),
    ...nodeFields,
    partIds: nodeFields.partIds.default([]),
    purchaseIds: nodeFields.purchaseIds.default([]),
  })
  .strict()

export const patchNodeBody = z.object(nodeFields).partial().strict()

export const listQuery = z.object({
  workOrderNumber: z.string().max(64).optional(),
  /** 1 = 只看未齐套 */
  incomplete: z.enum(['0', '1']).optional(),
  /** 1 = 我负责的节点（不受工单可见范围限制） */
  mine: z.enum(['0', '1']).optional(),
})

export const optionsQuery = z.object({ workOrderNumber: z.string().min(1).max(64) })
