/** 总计划 W9 判定、提醒文案与部门日期提示；纯函数。 */
import type { AlertLevel } from '@prisma/client'
import type { RuleThreshold } from '../alerts/rules'
import type { NodeEstimate, PlanForecast } from './estimate-types'
import { dayDiff, HOUR_MS } from '../../../shared/dates'

// ───────────── W9 ─────────────

/**
 * W9 节点级：只报源头节点（自身就已延误；只因上游顺延的不报），级别按自身延误天数：≥ 红阈值红，≥ 黄阈值黄。
 */
export function judgeW9(n: Pick<NodeEstimate, 'source' | 'selfDelayDays'>, t: RuleThreshold): AlertLevel | null {
  if (!n.source) return null
  if (n.selfDelayDays >= t.redDays) return 'RED'
  if (n.selfDelayDays >= t.yellowDays) return 'YELLOW'
  return null
}

/** W9 工单级：预计交期晚于 QMS 交期 → 红 */
export function judgeW9Plan(deliveryDelayDays: number | null): AlertLevel | null {
  return deliveryDelayDays != null && deliveryDelayDays > 0 ? 'RED' : null
}

const SELF_DRIVER_TEXT = { self: '', task: '部门任务延误', today: '计划日已过仍未完成', actual: '' } as const

/** W9 节点级提醒标题里冒号后面的部分 */
export function w9Summary(n: Pick<NodeEstimate, 'selfExpectedDay' | 'selfDelayDays' | 'selfDriver' | 'expectedDay' | 'delayDays'>, planDay: string): string {
  const why = SELF_DRIVER_TEXT[n.selfDriver]
  const tail = n.delayDays > n.selfDelayDays ? `；加上游顺延预计 ${n.expectedDay}` : ''
  return `计划 ${planDay}，预计 ${n.selfExpectedDay} 完成，晚 ${n.selfDelayDays} 天${why ? `（${why}）` : ''}${tail}`
}

/** W9 工单级提醒标题里冒号后面的部分 */
export function w9PlanSummary(deliveryDay: string, f: Pick<PlanForecast, 'expectedDelivery' | 'deliveryDelayDays'>, sources: string[]): string {
  const src = sources.length ? `；源头延误节点：${sources.join('、')}` : ''
  return `合同交期 ${deliveryDay}，按总计划预计 ${f.expectedDelivery} 交付，拖期 ${f.deliveryDelayDays} 天${src}`
}

/**
 * W9 节点未分解（部门计划二次分解，10-22）：总计划已发布、节点没完成、节点下没有任何部门任务（4 类记录 + 其他任务，不算已取消的），
 * 从发布（发布后才加的节点从加的时候）起已过 W9 的提醒小时数（默认 72 小时，停工日不计）→ 提醒（REMIND），只提醒不升级、不转异常。
 * 提醒小时数为空时不报。elapsedMs 由调用方按停工日算好。
 */
export function judgeSplit(n: { done: boolean; taskCount: number }, elapsedMs: number, remindHours: number | null): AlertLevel | null {
  if (remindHours == null || n.done || n.taskCount > 0) return null
  return elapsedMs >= remindHours * HOUR_MS ? 'REMIND' : null
}

/** 部门日期晚于节点日的提示（保存时返回给页面；只提示不拦截） */
export function lateWarning(what: string, recordDay: string | null, node: { name: string; planDay: string } | null): string | null {
  if (!node || !recordDay || recordDay <= node.planDay) return null
  return `${what} ${recordDay} 晚于总计划节点"${node.name}"的计划日 ${node.planDay}（晚 ${dayDiff(node.planDay, recordDay)} 天），已保存，总计划里会标红`
}
