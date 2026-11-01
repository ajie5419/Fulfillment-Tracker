/** 总计划无副作用校验；输入是日期字段的 YYYY-MM-DD，不换算为浏览器本地日期。 */
export function isPlanStartLate(startDay: string | null | undefined, planDay: string | null | undefined): boolean {
  return !!startDay && !!planDay && startDay > planDay
}

/** 发布后新增 / 删除节点要原因；编辑时仅计划完成日变化要原因，缺少新日期不算变化。 */
export function planAdjustmentNeedsReason(published: boolean, previousDay: string | null = null, nextDay?: string | null): boolean {
  return published && (previousDay === null || (!!nextDay && nextDay !== previousDay))
}

/** 已确定这次调整需要原因时，空值及全空白都不合法；不改变两端各自的提示文案。 */
export function isPlanAdjustmentReasonMissing(required: boolean, reason: string | null | undefined): boolean {
  return required && !reason?.trim()
}
