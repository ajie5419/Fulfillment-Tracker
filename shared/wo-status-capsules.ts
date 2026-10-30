/** 工单状态只取看板行的业务计数；不从 redReason 文本、预警总数推断业务状态。 */
export interface WoStatusFields {
  shortage?: number
  purchasePending?: number
  drawingOverdue?: number
  overdueIssues?: number
  overdueSteps?: number
  incompleteNodes?: number
  stagnationRedDays?: number | null
  stagnationYellowDays?: number | null
  unsignedReleases?: number
}

export interface WoStatusCapsule {
  key: string
  text: string
  tone: 'late' | 'risk'
  hint?: string
}

export function woStatusCapsules(row: WoStatusFields): WoStatusCapsule[] {
  const capsules: WoStatusCapsule[] = []
  const add = (key: string, label: string, count: number | undefined, tone: 'late' | 'risk', hint?: string) => {
    if (count != null && count > 0) capsules.push({ key, text: `${label} ${count}`, tone, ...(hint ? { hint } : {}) })
  }
  add('shortage', '缺料', row.shortage, 'late')
  // 缺料是未到货行的子集；采购标签只展示其余行，两枚标签不重复计同一行。
  const otherPending = Math.max(0, (row.purchasePending ?? 0) - (row.shortage ?? 0))
  add('purchasePending', '外购件未到', otherPending, 'late', row.shortage ? `未到货共 ${row.purchasePending} 行，已排除缺料 ${row.shortage} 行` : undefined)
  add('drawingOverdue', '设计逾期', row.drawingOverdue, 'late')
  add('overdueIssues', '超期异常', row.overdueIssues, 'late')
  add('overdueSteps', '外协未回', row.overdueSteps, 'late')
  add('incompleteNodes', '未齐套', row.incompleteNodes, 'risk')
  if (row.stagnationRedDays != null) capsules.push({ key: 'stagnation', text: `停滞 ${row.stagnationRedDays} 天`, tone: 'late' })
  else if (row.stagnationYellowDays != null) capsules.push({ key: 'stagnation', text: `停滞关注 ${row.stagnationYellowDays} 天`, tone: 'risk' })
  add('unsignedReleases', '未签收', row.unsignedReleases, 'risk')
  // 同色沿词表顺序，红色全部先于黄色（未齐套沿用 W8 窗口风险语义）。
  return capsules.sort((a, b) => Number(a.tone === 'risk') - Number(b.tone === 'risk'))
}

/** 最多四枚：超过四项时，前三项 + 一枚 +N；+N 本身也占一枚。 */
export function visibleWoStatusCapsules(row: WoStatusFields) {
  const all = woStatusCapsules(row)
  const visible = all.length > 4 ? all.slice(0, 3) : all
  return { all, visible, hidden: all.slice(visible.length) }
}
