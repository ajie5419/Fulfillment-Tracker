/** 手机端齐套页（前端改版第二轮）：节点色调、缺件原因标签。纯函数。 */
import type { Tone } from './mobile-todo'

/** 节点色调：红色预警 → 红；黄色预警 → 黄；未齐套 → 主色；齐了 → 绿；清单为空 → 灰 */
export function kitTone(n: { percent: number | null; incomplete: boolean; alertLevel: 'REMIND' | 'YELLOW' | 'RED' | null }): Tone {
  if (n.percent == null) return 'none'
  if (n.alertLevel === 'RED') return 'late'
  if (n.alertLevel === 'YELLOW') return 'risk'
  if (n.incomplete) return 'primary'
  return 'done'
}

/**
 * 缺件原因汇总成标签（同一原因合并计数，多的在前）：工件用"卡在哪一步"（reason），物料用采购状态（stage，如 缺料 / 超承诺日）。
 * 有逾期、有异常的标红（danger），其余标黄（warning）。
 */
export function shortageReasonTags(
  shortages: { kind: 'part' | 'purchase'; reason: string; reasonCode: string; stage: string | null; overdue?: boolean }[],
): { text: string; count: number; type: 'danger' | 'warning' }[] {
  const m = new Map<string, { text: string; count: number; type: 'danger' | 'warning' }>()
  for (const s of shortages) {
    const text = s.kind === 'purchase' ? s.stage || s.reason : s.reason
    const danger = !!s.overdue || s.reasonCode === 'BLOCKED'
    const row = m.get(text) ?? { text, count: 0, type: 'warning' as const }
    row.count++
    if (danger) row.type = 'danger'
    m.set(text, row)
  }
  return [...m.values()].sort((a, b) => b.count - a.count || (a.type === b.type ? 0 : a.type === 'danger' ? -1 : 1))
}
