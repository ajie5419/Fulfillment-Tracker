/** 关键物料与付款（R10）接口的 zod 片段。日期一律用 schemas/flow.ts 的 day（拒绝 2026-02-30 这类不存在的日期） */
import { z } from 'zod'
import { MAX_PAYMENT_LINES } from '../services/purchases/constants'
import { day, source } from './flow'

/** 可空文本：去首尾空格，空串当 null；没传（undefined）保持 undefined，修改接口据此区分"不改"和"清空" */
const optText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}最多 ${max} 字`)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null))

const decimals = (n: number, places: number) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6

export const delayReason = z.enum(['PAYMENT', 'SUPPLIER', 'DEMAND_CHANGE', 'OTHER'], { message: '延误原因只能是 付款 / 供应商 / 我方需求变化 / 其他' })

const lineFields = {
  partId: z.string().max(191).nullish(),
  materialName: z.string().trim().min(1, '请填写物料名称').max(191, '物料名称最多 191 字'),
  spec: optText(191, '规格型号'),
  quantity: z
    .number({ message: '请填写数量' })
    .positive('数量要大于 0')
    .max(1e9, '数量太大')
    .refine((n) => decimals(n, 3), '数量最多 3 位小数'),
  unit: optText(20, '单位'),
  /** 选 QMS 供应商时填 ID；手填时只填 supplierName */
  supplierId: z.string().max(64).nullish(),
  supplierName: optText(191, '供应商'),
  needDate: day,
  promisedDate: day.nullish(),
  /** 所属总计划节点（R14）；工单已发布总计划时新建必填 */
  planNodeId: z.string().max(191).nullish(),
  /** 采购负责人；空 = 采购部负责人 */
  buyerId: z.string().max(64).nullish(),
  note: optText(500, '备注'),
}

export const newLineBody = z
  .object({
    workOrderNumber: z.string().min(1, '请选择工单').max(64),
    ...lineFields,
    /** 录入时已经到了 */
    arrivedDate: day.nullish(),
  })
  .strict()

export const patchLineBody = z
  .object({
    ...lineFields,
    delayReason: delayReason.nullish(),
    delayNote: optText(500, '延误说明'),
    status: z.enum(['OPEN', 'CANCELLED']),
    arrivedDate: day,
  })
  .partial()
  .strict()

export const arriveBody = z
  .object({
    /** 默认今天 */
    arrivedDate: day.nullish(),
    delayReason: delayReason.nullish(),
    delayNote: optText(500, '延误说明'),
    source,
  })
  .strict()

export const listQuery = z.object({
  workOrderNumber: z.string().max(64).optional(),
  partId: z.string().max(191).optional(),
  view: z.enum(['open', 'shortage', 'late', 'arrived', 'cancelled', 'all']).optional(),
  q: z.string().max(100).optional(),
})

export const paymentStatus = z.enum(['PENDING', 'PAID', 'ON_HOLD'], { message: '状态只能是 待付 / 已付 / 暂缓' })

export const newPaymentBody = z
  .object({
    purchaseLineIds: z.array(z.string().min(1).max(191)).min(1, '请选择采购行').max(MAX_PAYMENT_LINES, `最多关联 ${MAX_PAYMENT_LINES} 项`),
    amount: z
      .number({ message: '请填写金额' })
      .positive('金额要大于 0')
      .max(1e12, '金额太大')
      .refine((n) => decimals(n, 2), '金额最多 2 位小数'),
    requestDate: day,
    blocksDelivery: z.boolean().default(false),
    note: optText(500, '说明'),
  })
  .strict()

export const paymentStatusBody = z.object({ status: paymentStatus, note: optText(500, '处理意见') }).strict()

export const paymentQuery = z.object({
  status: z.enum(['UNPAID', 'PENDING', 'PAID', 'ON_HOLD', 'ALL']).optional(),
  workOrderNumber: z.string().max(64).optional(),
})
