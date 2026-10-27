/** 履约新建 / 修改 / 取消工单（写入 QMS 工单库）接口的 zod 片段。交期用 dayString（'YYYY-MM-DD' 原样发给 QMS） */
import { z } from 'zod'
import { dayString } from './flow'

const optText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}最多 ${max} 字`)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null))
const optId = z
  .string()
  .max(64)
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null))

/** 履约这边的扩展信息（work_order_ext）：项目经理、产品线、是否试点 */
const extFields = {
  projectManagerId: optId,
  productLine: optText(191, '产品线'),
  isPilot: z.boolean().optional(),
}

export const createWorkOrderBody = z
  .object({
    workOrderNumber: z.string().trim().min(1, '请填写工单号').max(64, '工单号最多 64 个字符'),
    customerNameId: z.string().min(1, '请选择客户').max(64),
    projectName: optText(191, '项目名称'),
    divisionId: optId,
    quantity: z.number({ message: '请填写数量' }).int('数量要是整数').min(1, '数量至少为 1'),
    deliveryDate: dayString,
    ...extFields,
  })
  .strict()

export const updateWorkOrderBody = z
  .object({
    /** 不允许改：带了且和地址里的不同 → 400（服务层判断） */
    workOrderNumber: z.string().trim().optional(),
    customerNameId: z.string().min(1, '请选择客户').max(64).optional(),
    projectName: optText(191, '项目名称'),
    divisionId: optId,
    quantity: z.number().int('数量要是整数').min(1, '数量至少为 1').optional(),
    deliveryDate: dayString.optional(),
    status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED'], { message: '状态只能是 未开始 / 进行中 / 已完工' }).optional(),
    ...extFields,
  })
  .strict()

export type CreateWorkOrderInput = z.output<typeof createWorkOrderBody>
export type UpdateWorkOrderInput = z.output<typeof updateWorkOrderBody>
