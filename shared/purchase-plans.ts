export type PurchasePlanStatus = 'DRAFT' | 'ISSUED' | 'WITHDRAWN'
export const PURCHASE_PLAN_ISSUED = 'PURCHASE_PLAN_ISSUED'
export const PURCHASE_PLAN_STATUS_TEXT: Record<PurchasePlanStatus, string> = { DRAFT: '草稿', ISSUED: '已下发', WITHDRAWN: '已撤回' }
export function purchasePlanEditable(status: PurchasePlanStatus) { return status === 'DRAFT' || status === 'WITHDRAWN' }
export function purchasePlanTransition(status: PurchasePlanStatus, action: 'issue' | 'withdraw'): PurchasePlanStatus | null {
  if (action === 'issue' && purchasePlanEditable(status)) return 'ISSUED'
  if (action === 'withdraw' && status === 'ISSUED') return 'WITHDRAWN'
  return null
}
/** 分母始终是计划全部明细，取消采购行仍算已转入，只有 ARRIVED 算已到货。 */
export function purchasePlanProgress(items: readonly { convertedLineId: string | null; convertedLine?: { status: string } | null }[]) {
  return { total: items.length, converted: items.filter(i => !!i.convertedLineId).length, arrived: items.filter(i => !!i.convertedLineId && i.convertedLine?.status === 'ARRIVED').length }
}
