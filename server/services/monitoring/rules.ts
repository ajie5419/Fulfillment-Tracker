import type { MonitoringLevel } from '../../../shared/monitoring'
import { alertKey, dayDiff, shanghaiDay, type RuleThreshold } from '../alerts/rules'

export type StatusSinceSource = 'statusSince' | 'flowEvent' | 'startedAt' | 'createdAt'

/**
 * 工序没有 statusSince 字段，按最近一条 FlowEvent.occurredAt 推导；无事件才依次回退 startedAt、createdAt。
 * 按 occurredAt 而非记录入库的 createdAt 排序，不筛事件种类：部分报工、报废同样会刷新推导时间。
 * 这是“最近流转活动”的代理口径，并非精确的状态变更审计；不能用 updatedAt 静默替代。
 */
export function stepStatusSince(step: { latestEventAt: Date | null; startedAt: Date | null; createdAt: Date }): { since: Date; source: StatusSinceSource } {
  if (step.latestEventAt) return { since: step.latestEventAt, source: 'flowEvent' }
  if (step.startedAt) return { since: step.startedAt, source: 'startedAt' }
  return { since: step.createdAt, source: 'createdAt' }
}

/** 工件直接沿用业务流程维护的 Part.statusSince，不从工序或 updatedAt 重算。 */
export const partStatusSince = (part: { statusSince: Date }): { since: Date; source: StatusSinceSource } => ({ since: part.statusSince, source: 'statusSince' })

/** 工厂时区自然日差：跨上海零点算一天，含停工日；未来时间归零。复用 alerts 日期工具。 */
export const residenceDays = (since: Date, now: Date) => Math.max(0, dayDiff(shanghaiDay(since), shanghaiDay(now)))

export function stagnationLevel(days: number, t: Pick<RuleThreshold, 'yellowDays' | 'redDays'>): MonitoringLevel {
  if (days >= t.redDays) return 'RED'
  if (days >= t.yellowDays) return 'YELLOW'
  return 'GREEN'
}

/**
 * W11 按“当前状态 + 本轮计时起点”区分停滞周期。同一周期幂等；状态变化 / 新事件 / statusSince 重置后，
 * 旧键不在本轮 live 集合中，复用扫描的 clear 机制消除。低于红线时不收集目标，调大阈值也能消除。
 */
export const stagnationKey = (entity: { entityType: 'step' | 'part'; id: string; status: string; since: Date }) =>
  `${alertKey('W11', entity.entityType, entity.id)}:${entity.status}:${+entity.since}`
