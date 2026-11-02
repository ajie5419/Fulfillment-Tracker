import { stuckNode, type NodeState } from './status'
import type { WoStatusFields } from './wo-status-capsules'

/** /board 的视图只由权限和 URL 决定，同页提醒、前进 / 后退也遵循这一落点。 */
export type BoardView = 'cockpit' | 'board'
export function resolveBoardView(canOverview: boolean, queryView: unknown): BoardView {
  return canOverview && queryView !== 'board' ? 'cockpit' : 'board'
}

export const BOARD_VIEWS = [{ value: 'cockpit', label: '今天盯什么' }, { value: 'board', label: '工单看板' }]
export const OVERDUE_ISSUES_LINK = '/risks?tab=issues&overdue=1&dept=0'
export const RED_WORK_ORDERS_LINK = '/board?view=board&color=RED'
export const STAGNATION_RED_LINK = '/monitoring?level=RED'

interface OverviewNumbers {
  summary: { red: number; overdueIssues: number }
  stages: { key: string; count: number }[]
}

/** 停滞只取完整集合的 redCount，不能使用 Top 长度。 */
export function cockpitMetrics(overview: OverviewNumbers | null | undefined, releases: { pending: number } | null | undefined, monitoring?: { redCount: number } | null) {
  return [
    { key: 'red', label: '红色工单', value: overview?.summary.red ?? '—', unit: '个', tone: 'late', to: RED_WORK_ORDERS_LINK },
    { key: 'overdue', label: '超期异常', value: overview?.summary.overdueIssues ?? '—', unit: '条', tone: 'late', to: OVERDUE_ISSUES_LINK },
    { key: 'unsigned', label: '未签收发放', value: releases?.pending ?? '—', unit: '份', tone: 'risk', to: '/releases?progress=PENDING' },
    { key: 'shortage', label: '缺料项', value: overview?.stages.find((s) => s.key === 'shortage')?.count ?? '—', unit: '项', tone: 'risk', to: '/purchases?view=shortage' },
    { key: 'stagnation', label: '停滞红线', value: monitoring?.redCount ?? '—', unit: '项', tone: 'late', to: STAGNATION_RED_LINK },
  ] as const
}

export interface CockpitRedWorkOrder extends WoStatusFields {
  workOrderNumber: string
  projectName: string | null
  projectManagerName: string | null
  reason: string
  delayDays?: number | null
}
export interface CockpitIssue {
  id: string
  issueNo: string
  description: string
  workOrderNumber: string
  responsibleDeptName: string | null
  responsibleUserName: string | null
  overdue: boolean
  overdueDays: number
}
export interface CockpitStagnation {
  entityType: 'step' | 'part'
  id: string
  name: string
  workOrderNumber: string
  statusText: string
  days: number
  level: 'GREEN' | 'YELLOW' | 'RED'
  deptNames: string[]
  owners: { name: string | null }[]
  link: string
}
/** 一项具体问题；附加项保留各自的责任方、时长和详情入口。 */
export interface CockpitConcern {
  key: string
  kind: 'workOrder' | 'issue' | 'stagnation'
  label: string
  title: string
  detail: string
  workOrderNumber: string
  responsibility: string
  duration: string
  days: number | null
  to: string
  workOrder?: CockpitRedWorkOrder
}
export interface CockpitItem extends CockpitConcern {
  /** 主项以外的所有问题（包括同类型的其他异常 / 停滞对象）。 */
  also: CockpitConcern[]
}

/**
 * 管理优先级固定为：红色工单（工单级协调）→ 超期异常（处理闭环）→ W11 红线（在制停滞）。
 * 按工单分组，一单一行；同优先级取天数最大的问题为主项，其余全部进入 also。
 * 行 days 为该单已知超期 / 停滞 / 预计拖期天数的最大值，仅用于排序；duration 保留主项的时钟文案。
 * 先按主类型、再按行 days 倒序、同天数按工单 key 排，最后截取 10 单。
 * 待受理超时也属于超期异常，但 overdueDays = 0 时不编造解决日超期时长。
 * 调用方应提供完整候选集合；按对象截断的 monitoring.top 可能被同一工单占满，不能保证填满 10 单。
 */
export function mergeCockpitItems(input: {
  redWorkOrders: readonly CockpitRedWorkOrder[]
  issues: readonly CockpitIssue[]
  stagnation: readonly CockpitStagnation[]
}): CockpitItem[] {
  const rows: CockpitConcern[] = [
    ...input.redWorkOrders.map((r): CockpitConcern => ({
      key: `wo:${r.workOrderNumber}`, kind: 'workOrder', label: '红色工单',
      title: r.projectName || r.workOrderNumber, detail: r.reason, workOrderNumber: r.workOrderNumber,
      responsibility: r.projectManagerName ? `项目经理 ${r.projectManagerName}` : '未设置项目经理',
      days: null, duration: '时长未提供',
      to: `/wo/${encodeURIComponent(r.workOrderNumber)}`,
      workOrder: r,
    })),
    ...input.issues.filter((i) => i.overdue).map((i): CockpitConcern => ({
      key: `issue:${i.id}`, kind: 'issue', label: '超期异常', title: `${i.issueNo} · ${i.description}`, detail: '',
      workOrderNumber: i.workOrderNumber,
      responsibility: [i.responsibleDeptName, i.responsibleUserName].filter(Boolean).join(' · ') || '未指定责任方',
      days: i.overdueDays > 0 ? i.overdueDays : null, duration: i.overdueDays > 0 ? `已超期 ${i.overdueDays} 天` : '待受理超时',
      to: `${OVERDUE_ISSUES_LINK}&id=${encodeURIComponent(i.id)}`,
    })),
    ...input.stagnation.filter((e) => e.level === 'RED').map((e): CockpitConcern => ({
      key: `${e.entityType}:${e.id}`, kind: 'stagnation', label: '停滞红线', title: e.name,
      detail: `${e.entityType === 'step' ? '工序' : '工件'} · ${e.statusText}`, workOrderNumber: e.workOrderNumber,
      responsibility: [...e.deptNames, ...e.owners.map((o) => o.name)].filter(Boolean).join(' · ') || '未指定责任方',
      days: e.days, duration: `已停 ${e.days} 天`, to: e.link,
    })),
  ]
  const rank = { workOrder: 0, issue: 1, stagnation: 2 }
  const compare = (a: CockpitConcern, b: CockpitConcern) => rank[a.kind] - rank[b.kind] || (b.days ?? -1) - (a.days ?? -1) || a.key.localeCompare(b.key)
  const groups = new Map<string, [CockpitConcern, ...CockpitConcern[]]>()
  for (const row of rows) {
    const group = groups.get(row.workOrderNumber)
    if (group) group.push(row)
    else groups.set(row.workOrderNumber, [row])
  }
  const items = [...groups.entries()].map(([wo, concerns]): CockpitItem => {
    concerns.sort(compare)
    const main = concerns[0]
    const also = concerns.slice(1)
    const durations = concerns.flatMap((r) => r.days === null ? [] : [{ days: r.days, duration: r.kind === 'issue' ? `异常最长已超 ${r.days} 天` : r.duration }])
    // 工单字段已有完整集合的停滞摘要，即使停滞对象没在调用方 Top 中，也保留其排序权重。
    for (const r of concerns) if (r.workOrder) {
      for (const days of [r.workOrder.stagnationRedDays, r.workOrder.stagnationYellowDays]) {
        if (days != null && days > 0) durations.push({ days, duration: `已停 ${days} 天` })
      }
      const delayDays = r.workOrder.delayDays
      if (delayDays != null && delayDays > 0) durations.push({ days: delayDays, duration: `预计拖期 ${delayDays} 天` })
    }
    durations.sort((a, b) => b.days - a.days || a.duration.localeCompare(b.duration))
    return {
      ...main, key: `wo:${wo}`, days: durations[0]?.days ?? null,
      duration: main.kind === 'workOrder' ? durations[0]?.duration ?? main.duration : main.duration,
      also,
    }
  })
  return items.sort(compare).slice(0, 10)
}
export const RED_STAGE_LABELS = { drawing: '设计', purchase: '采购', kitting: '齐套', outsource: '外协', production: '生产', other: '其他' } as const
type RedStage = keyof typeof RED_STAGE_LABELS

/** 最早 SOURCE 节点归属；节点专名优先于部门，其他部门及无 SOURCE 均归其他。每单恰好一次。 */
export function redWorkOrderStages(rows: readonly {
  color: string
  closed?: boolean
  planNodes: { seq: number; state: NodeState; name: string; dept: string }[]
}[]) {
  const counts: Record<RedStage, number> = { drawing: 0, purchase: 0, kitting: 0, outsource: 0, production: 0, other: 0 }
  for (const row of rows) {
    if (row.closed || row.color !== 'RED') continue
    const node = stuckNode(row.planNodes)
    let stage: RedStage = 'other'
    if (node) {
      if (/齐套/.test(node.name)) stage = 'kitting'
      else if (/外协|外包/.test(node.name)) stage = 'outsource'
      else if (node.dept === 'TECH' || node.dept === 'PROCESS') stage = 'drawing'
      else if (node.dept === 'PURCHASE') stage = 'purchase'
      else if (node.dept === 'PRODUCTION') stage = 'production'
    }
    counts[stage]++
  }
  return (Object.keys(RED_STAGE_LABELS) as RedStage[]).map((key) => ({ key, label: RED_STAGE_LABELS[key], count: counts[key] })).filter((s) => s.count > 0)
}
