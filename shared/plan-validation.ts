export const PLAN_CHANGE_KIND = { DATE: '改完成日期', START: '改开始日期', ADD: '加节点', DELETE: '删节点', PROCESS: '改工艺处理要求' } as const

/** 总计划无副作用校验；输入是日期字段的 YYYY-MM-DD，不换算为浏览器本地日期。 */
export function isPlanStartLate(startDay: string | null | undefined, planDay: string | null | undefined): boolean {
  return !!startDay && !!planDay && startDay > planDay
}

/** Published edits require a reason for either date; omitted fields are unchanged. */
export function planAdjustmentNeedsReason(published: boolean, previousDay: string | null = null, nextDay?: string | null, previousStart?: string | null, nextStart?: string | null): boolean {
  return published && (previousDay === null || (!!nextDay && nextDay !== previousDay) || (nextStart !== undefined && nextStart !== (previousStart ?? null)))
}

/** 已确定这次调整需要原因时，空值及全空白都不合法；不改变两端各自的提示文案。 */
export function isPlanAdjustmentReasonMissing(required: boolean, reason: string | null | undefined): boolean {
  return required && !reason?.trim()
}
