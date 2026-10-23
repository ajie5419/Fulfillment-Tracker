/** 项目部总计划（R14）接口的 zod 片段。日期一律用 schemas/flow.ts 的 day（拒绝 2026-02-30 这类不存在的日期） */
import { z } from 'zod'
import { BUSINESS_DEPT_NAME } from '../../shared/business-depts'
import { day } from './flow'

export const businessDept = z.enum(['TECH', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT'], { message: `责任部门只能是 ${Object.values(BUSINESS_DEPT_NAME).join(' / ')}` })

const wo = z.string().min(1, '请选择工单').max(64)
const reason = z
  .string()
  .trim()
  .max(500, '原因最多 500 字')
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null))

const phase = z
  .string()
  .trim()
  .max(64, '阶段名称最多 64 字')
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null))

const nodeFields = {
  name: z.string().trim().min(1, '请填写节点名称').max(191, '节点名称最多 191 字'),
  dept: businessDept,
  planDate: day,
  /** 阶段（分组显示） */
  phase,
  /** 计划开始日（可选） */
  startDate: day.nullish(),
  /** 前置节点 ID：null = 默认上一个节点；[] = 没有前置 */
  preds: z.array(z.string().min(1).max(191)).max(60, '前置节点最多 60 个').nullish(),
  /** 上级节点 ID（子节点，只有一层）：null = 一级节点 */
  parentId: z.string().min(1).max(191).nullish(),
  /** 顺序号：小的在前；不填 = 排最后 */
  seq: z.number().int().min(-100000).max(100000).nullish(),
  note: z
    .string()
    .trim()
    .max(500, '备注最多 500 字')
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
  /** 已发布时改日期、加节点必填 */
  reason,
}

export const woQuery = z.object({ workOrderNumber: wo })
export const woBody = z.object({ workOrderNumber: wo }).strict()
export const generateBody = z.object({ workOrderNumber: wo, templateId: z.string().min(1, '请选择模板').max(191) }).strict()
export const newNodeBody = z.object({ workOrderNumber: wo, ...nodeFields }).strict()
export const patchNodeBody = z.object(nodeFields).partial().strict()
export const deleteNodeBody = z.object({ reason }).strict()
export const rejectBody = z.object({ reason: z.string().trim().min(1, '请写退回原因').max(500, '原因最多 500 字') }).strict()
export const completeBody = z.object({ date: day.nullish() }).strict()

export const templateBody = z
  .object({
    name: z.string().trim().min(1, '请填写模板名称').max(191, '模板名称最多 191 字'),
    description: z.string().trim().max(500, '说明最多 500 字').nullish(),
    nodes: z
      .array(
        z.object({
          name: z.string().trim().min(1, '请填写节点名称').max(191, '节点名称最多 191 字'),
          dept: businessDept,
          daysBeforeDelivery: z.number().int('天数要是整数').min(-365, '天数太小').max(2000, '天数太大'),
          phase,
          /** 工期（天）：空 = 不设开始日 */
          durationDays: z.number().int('工期要是整数').min(1, '工期至少 1 天').max(2000, '工期太长').nullish(),
          /** 前置节点（本模板里的顺序号，从 1 开始）：null = 默认上一个节点；[] = 没有前置 */
          preds: z.array(z.number().int().min(1).max(60)).max(60).nullish(),
          /** 上级节点的顺序号（子节点，只有一层，上级要排在前面）：null = 一级节点 */
          parent: z.number().int().min(1).max(60).nullish(),
        }).strict(),
      )
      .min(1, '模板至少要有一个节点')
      .max(60, '模板最多 60 个节点'),
  })
  .strict()

// ───── 部门计划二次分解：其他任务、挂工序 ─────
const taskFields = {
  name: z.string().trim().min(1, '请填写任务名称').max(191, '任务名称最多 191 字'),
  ownerId: z.string().min(1, '请选择负责人').max(64),
  planDate: day,
  note: z
    .string()
    .trim()
    .max(500, '备注最多 500 字')
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
}
export const newTaskBody = z.object(taskFields).strict()
export const patchTaskBody = z.object(taskFields).partial().strict()
export const linkStepsBody = z.object({ stepIds: z.array(z.string().min(1).max(191)).min(1, '请选择工序').max(500, '一次最多 500 道工序') }).strict()

/** 部门计划页：部门（不填按本人部门）、工单筛选、定位节点 */
export const deptPlanQuery = z.object({
  dept: businessDept.optional(),
  wo: z.string().max(64).optional(),
  node: z.string().max(64).optional(),
})
