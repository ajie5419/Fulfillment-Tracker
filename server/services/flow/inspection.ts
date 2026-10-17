/** QMS 报检的纯函数（不碰数据库）：涉及的工单、外协单位。匹配、可见范围、不合格转异常共用。 */
import type { QmsInspection } from '@prisma/client'

/** 报检涉及的全部工单号：主工单 + 关联工单，去重（workOrderNumbers 是 JSON 数组，格式不对的元素忽略） */
export function inspectionWorkOrders(ins: Pick<QmsInspection, 'workOrderNumber'> & { workOrderNumbers?: QmsInspection['workOrderNumbers'] }): string[] {
  const extra = Array.isArray(ins.workOrderNumbers) ? ins.workOrderNumbers.filter((x): x is string => typeof x === 'string' && !!x) : []
  return [...new Set([ins.workOrderNumber, ...extra])]
}

/** 报检的外协单位：供应商优先，没有时取厂内外协班组（qms_supplier 里 kind = TEAM 的同一 id） */
export const inspectionSupplierId = (ins: Pick<QmsInspection, 'supplierId'> & { teamId?: string | null }) => ins.supplierId || ins.teamId || null
