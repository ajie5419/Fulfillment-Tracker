import { describe, expect, it } from 'vitest'
import { ALERT_RULES, RULE_TEXT } from '../../shared/alert-rules'
import { monitoringDetailLink } from '../../shared/monitoring'
import { CONVERTIBLE_RULES, DEFAULT_THRESHOLDS, reminderTitle } from '../../server/services/alerts/rules'
import { partStatusSince, residenceDays, stagnationKey, stagnationLevel, stepStatusSince } from '../../server/services/monitoring/rules'
import type { MonitoredEntity } from '../../server/services/monitoring/status'
import { monitoringSummary } from '../../server/services/monitoring/status'
import { stagnationTargets } from '../../server/services/monitoring/targets'

const t = DEFAULT_THRESHOLDS.W11
const at = (s: string) => new Date(`${s}+08:00`)
const entity = (days: number, extra: Partial<MonitoredEntity> = {}): MonitoredEntity => ({
  entityType: 'step', id: `step-${days}`, partId: 'part', name: '主梁 · 组焊', drawingNo: 'D-1', workOrderNumber: 'WO-1',
  status: 'PENDING', statusText: '待开工', since: at('2026-10-01T09:00:00'), sinceSource: 'createdAt',
  days, level: stagnationLevel(days, t), ownerIds: [], owners: [], deptNames: [], link: '/parts?wo=WO-1&part=part', ...extra,
})

describe('状态进入时间与工厂自然日', () => {
  const createdAt = at('2026-10-01T09:00:00')
  const startedAt = at('2026-10-02T09:00:00')
  const latestEventAt = at('2026-10-03T09:00:00')

  it('工件只用 Part.statusSince，不受创建时间、工序活动影响', () => {
    const statusSince = at('2026-10-05T09:00:00')
    expect(partStatusSince({ statusSince, ...{ createdAt, startedAt, latestEventAt } })).toEqual({ since: statusSince, source: 'statusSince' })
  })
  it('工序优先取最近流转 occurredAt', () => {
    expect(stepStatusSince({ latestEventAt, startedAt, createdAt })).toEqual({ since: latestEventAt, source: 'flowEvent' })
  })
  it('即使事件比 startedAt 更早，也遵循约定的事件优先链，不静默取最大值', () => {
    expect(stepStatusSince({ latestEventAt: createdAt, startedAt, createdAt })).toEqual({ since: createdAt, source: 'flowEvent' })
  })
  it('工序无事件时回退 startedAt', () => {
    expect(stepStatusSince({ latestEventAt: null, startedAt, createdAt })).toEqual({ since: startedAt, source: 'startedAt' })
  })
  it('工序无事件且未开工时回退 createdAt', () => {
    expect(stepStatusSince({ latestEventAt: null, startedAt: null, createdAt })).toEqual({ since: createdAt, source: 'createdAt' })
  })
  it('跨上海零点算一天，不是跨 UTC 零点或满 24 小时', () => {
    expect(residenceDays(new Date('2026-10-01T15:59:59Z'), new Date('2026-10-01T16:00:00Z'))).toBe(1)
    expect(residenceDays(new Date('2026-10-01T23:59:59Z'), new Date('2026-10-02T00:00:00Z'))).toBe(0)
  })
  it('同一天是 0 天，未来计时起点也归零', () => {
    expect(residenceDays(createdAt, createdAt)).toBe(0)
    expect(residenceDays(latestEventAt, createdAt)).toBe(0)
  })
})

describe('W11 分级与扫描生命周期', () => {
  it('登记默认值、中文名称，并且红线只发预警不自动转异常', () => {
    expect(ALERT_RULES).toContain('W11')
    expect(RULE_TEXT.W11).toBe('W11 在制状态停滞')
    expect(t).toEqual({ remindHours: null, yellowDays: 7, redDays: 14 })
    expect(CONVERTIBLE_RULES).not.toContain('W11')
  })
  it.each([[0, 'GREEN'], [6, 'GREEN'], [7, 'YELLOW'], [13, 'YELLOW'], [14, 'RED'], [15, 'RED']] as const)('%s 天 → %s（含恰达黄 / 红线）', (days, expected) => {
    expect(stagnationLevel(days, t)).toBe(expected)
  })
  it('阈值可配且相等时红色优先', () => {
    expect(stagnationLevel(3, { yellowDays: 2, redDays: 3 })).toBe('RED')
    expect(stagnationLevel(7, { yellowDays: 7, redDays: 7 })).toBe('RED')
  })
  it('仅红线生成目标，黄线及正常都不创建预警', () => {
    const targets = stagnationTargets([entity(6), entity(7), entity(14), entity(15, { entityType: 'part', status: 'ACTIVE', statusText: '在制' })])
    expect(targets).toHaveLength(2)
    expect(targets[0]).toMatchObject({ rule: 'W11', refType: 'step', level: 'RED', summary: '工序处于“待开工”已停 14 天', workOrderNumber: 'WO-1', ownerIds: [] })
    expect(targets[1]).toMatchObject({ refType: 'part', summary: '工件处于“在制”已停 15 天' })
  })
  it('同一停滞周期键不变，重复扫描幂等', () => {
    expect(stagnationTargets([entity(14)])[0]!.key).toBe(stagnationTargets([entity(15, { id: 'step-14' })])[0]!.key)
  })
  it('实体名很长时仍保留状态、天数及完整工单号', () => {
    const target = stagnationTargets([entity(14, { name: '主梁'.repeat(200), workOrderNumber: 'W'.repeat(64) })])[0]!
    const title = reminderTitle('RED', target.subject, target.summary, target.workOrderNumber)
    expect(title).toContain('工序处于“待开工”已停 14 天')
    expect(title).toContain('W'.repeat(64))
    expect(title.length).toBeLessThanOrEqual(190)
  })
  it('状态变化即退出旧 live 键，哪怕新的状态也已达红线', () => {
    const old = entity(14)
    const changed = { ...old, status: 'BLOCKED' as const, statusText: '有异常' }
    const live = new Set(stagnationTargets([changed]).map((x) => x.key))
    expect(live.has(stagnationKey(old))).toBe(false)
  })
  it.each(['step', 'part'] as const)('%s 计时起点更新后退出旧周期，返回同一状态也能重新报警', (entityType) => {
    const old = entity(14, { entityType })
    expect(stagnationKey({ ...old, since: at('2026-10-02T09:00:00') })).not.toBe(stagnationKey(old))
    expect(stagnationKey(old).length).toBeLessThanOrEqual(120)
  })
  it('阈值调大后低于红线，旧键不再 live，可由扫描自动消除', () => {
    const old = entity(14)
    const adjusted = { ...old, level: stagnationLevel(old.days, { yellowDays: 10, redDays: 20 }) }
    expect(stagnationTargets([adjusted])).toEqual([])
  })
})

describe('总览与下钻', () => {
  it('分布包含零计数状态，数字下钻不丢失实体类型与状态', () => {
    const summary = monitoringSummary([entity(14), entity(7, { entityType: 'part', status: 'ACTIVE' })])
    expect(summary.steps).toEqual([
      { status: 'PENDING', label: '待开工', count: 1, link: '/monitoring?entityType=step&status=PENDING' },
      { status: 'OUT', label: '在外加工', count: 0, link: '/monitoring?entityType=step&status=OUT' },
      { status: 'IN_PROGRESS', label: '加工中', count: 0, link: '/monitoring?entityType=step&status=IN_PROGRESS' },
      { status: 'BLOCKED', label: '有异常', count: 0, link: '/monitoring?entityType=step&status=BLOCKED' },
    ])
    expect(summary.parts[0]).toMatchObject({ status: 'ACTIVE', count: 1, link: '/monitoring?entityType=part&status=ACTIVE' })
  })
  it('Top 10 仅取黄红，保留服务层的天数降序', () => {
    const summary = monitoringSummary(Array.from({ length: 20 }, (_, i) => entity(20 - i)))
    expect(summary.top.map((e) => e.days)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11])
    expect(monitoringSummary([entity(6)]).top).toEqual([])
  })
  it('详情链接安全编码工单号和实体 ID，并定位确切工序', () => {
    const link = new URL(monitoringDetailLink('工单 A&1', 'p&1', 's&1'), 'http://localhost')
    expect(link.pathname).toBe('/parts')
    expect([...link.searchParams]).toEqual([['wo', '工单 A&1'], ['part', 'p&1'], ['step', 's&1']])
  })
})
