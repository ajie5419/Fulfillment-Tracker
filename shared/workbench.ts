/**
 * 前端改版第二轮的纯函数（前端 app/ 与服务端 server/ 共用，不依赖任何运行时）：
 *   工作台卡片流按截止日分组（已过期 / 今天 / 本周 / 以后）、部门工作台按工单分组和本组完成度、风险页的严重度和责任部门汇总。
 * 日期一律用 'YYYY-MM-DD' 字符串比较；"今天"由服务端按工厂时区（Asia/Shanghai）算好传进来，不用浏览器本地时区。
 * 前端用 #shared/workbench，服务端用相对路径引用。
 */

// ───────────── 工作台：按截止日分组 ─────────────

/** NO_DUE = 未定截止日（服务端建待办时多数不写截止日，单独一组，不硬归到"以后"） */
export type WorkBucket = 'OVERDUE' | 'TODAY' | 'WEEK' | 'LATER' | 'NO_DUE'
export const WORK_BUCKETS: readonly WorkBucket[] = ['OVERDUE', 'TODAY', 'WEEK', 'LATER', 'NO_DUE']
export const WORK_BUCKET_TEXT: Readonly<Record<WorkBucket, string>> = { OVERDUE: '已过期', TODAY: '今天', WEEK: '本周', LATER: '以后', NO_DUE: '未定截止日' }

const DAY_MS = 86_400_000
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** 本周日（周一到周日算一周，与出图任务"本周到期"一致）；today 是周日时就是 today */
export function weekEndDay(today: string): string {
  const ms = dayMs(today)
  const dow = (new Date(ms).getUTCDay() + 6) % 7 // 周一 0 … 周日 6
  return fmt(ms + (6 - dow) * DAY_MS)
}

export interface WorkItemLike {
  /** 截止日 'YYYY-MM-DD'；没有为 null */
  dueDay: string | null
  /** 待办 / 提醒 */
  kind: 'todo' | 'reminder'
  /** 提醒的级别（待办没有） */
  level?: 'RED' | 'YELLOW' | 'REMIND' | null
  /** 预警已消除（对象状态已变化，不再有截止日） */
  cleared?: boolean
}

/**
 * 一条待办 / 提醒落在哪一组（today 为工厂时区的今天），只按真实截止日：
 *   早于今天 → 已过期；今天 → 今天；本周日之前 → 本周；更晚 → 以后；
 *   没有截止日（多数待办、发放签收、节点超时未确认等）、已消除的预警 → 未定截止日。
 * 级别（红 / 黄）只决定卡片颜色和组内排序，不改分组。
 */
export function workBucket(item: WorkItemLike, today: string): WorkBucket {
  const due = item.cleared ? null : item.dueDay
  if (!due) return 'NO_DUE'
  if (due < today) return 'OVERDUE'
  if (due === today) return 'TODAY'
  return due <= weekEndDay(today) ? 'WEEK' : 'LATER'
}

/** 按组排好（组内保持原顺序），空组去掉 */
export function groupByBucket<T extends { bucket: WorkBucket }>(items: T[]): { bucket: WorkBucket; items: T[] }[] {
  return WORK_BUCKETS.map((bucket) => ({ bucket, items: items.filter((i) => i.bucket === bucket) })).filter((g) => g.items.length)
}

// ───────────── 部门工作台：按工单分组 ─────────────

export interface WoGroup<T> {
  workOrderNumber: string
  rows: T[]
}

/** 按工单分组：组的顺序按每个工单第一次出现的位置（列表原来的排序不变），组内保持原顺序 */
export function groupByWorkOrder<T extends { workOrderNumber: string }>(rows: T[]): WoGroup<T>[] {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const list = m.get(r.workOrderNumber)
    if (list) list.push(r)
    else m.set(r.workOrderNumber, [r])
  }
  return [...m].map(([workOrderNumber, list]) => ({ workOrderNumber, rows: list }))
}

/** 本组完成度：counted 里有几条 done（已取消、已作废等不计入的用 counted 排除） */
export function groupProgress<T>(rows: T[], done: (r: T) => boolean, counted: (r: T) => boolean = () => true): { done: number; total: number } {
  const list = rows.filter(counted)
  return { done: list.filter(done).length, total: list.length }
}

/** 组里挂的总计划节点（去重，按序号） */
export function distinctPlanNodes<N extends { id: string; seq: number }>(rows: { planNode?: N | null }[]): N[] {
  const m = new Map<string, N>()
  for (const r of rows) if (r.planNode) m.set(r.planNode.id, r.planNode)
  return [...m.values()].sort((a, b) => a.seq - b.seq)
}

/** 平均齐套率（清单为空的节点不计入）；没有可算的为 null */
export function averagePercent(rows: { percent: number | null }[]): number | null {
  const list = rows.map((r) => r.percent).filter((p): p is number => p != null)
  return list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null
}

/** 缺件按原因计数（多的在前，同数按原因文字） */
export function shortageReasonCounts(shortages: { reason: string; reasonCode: string }[]): { code: string; reason: string; count: number }[] {
  const m = new Map<string, { code: string; reason: string; count: number }>()
  for (const s of shortages) {
    const row = m.get(s.reason) ?? { code: s.reasonCode, reason: s.reason, count: 0 }
    row.count++
    m.set(s.reason, row)
  }
  return [...m.values()].sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
}

// ───────────── 风险页（预警 + 异常）─────────────

/** 严重度：红色预警、黄色预警、超期异常、未超期异常 */
export type RiskSeverity = 'RED' | 'YELLOW' | 'ISSUE_OVERDUE' | 'ISSUE_OPEN'
export const RISK_SEVERITIES: readonly RiskSeverity[] = ['RED', 'YELLOW', 'ISSUE_OVERDUE', 'ISSUE_OPEN']
export const RISK_SEVERITY_TEXT: Readonly<Record<RiskSeverity, string>> = { RED: '红色预警', YELLOW: '黄色预警', ISSUE_OVERDUE: '超期异常', ISSUE_OPEN: '未超期异常' }

export interface RiskAlertLike {
  level: 'RED' | 'YELLOW' | 'REMIND'
  /** ACTIVE / CONVERTED：已转异常的只算异常那一条，避免重复 */
  status: string
  deptNames: string[]
}
export interface RiskIssueLike {
  status: string
  overdue: boolean
  deptGroup: string | null
}

/** 预警算不算风险：活动中（未转异常）的红、黄预警；提醒级别不算 */
export function alertSeverity(a: RiskAlertLike): RiskSeverity | null {
  if (a.status !== 'ACTIVE') return null
  return a.level === 'RED' ? 'RED' : a.level === 'YELLOW' ? 'YELLOW' : null
}

/** 异常算不算风险：未关闭的，超期 / 未超期 */
export function issueSeverity(i: RiskIssueLike): RiskSeverity | null {
  if (i.status === 'CLOSED') return null
  return i.overdue ? 'ISSUE_OVERDUE' : 'ISSUE_OPEN'
}

/** 没有责任部门时归到这一项 */
export const NO_DEPT = '未指定部门'

/**
 * 风险汇总（风险页顶部两张横条图）：按严重度、按责任部门计数。
 * 预警的责任部门可能有多个（如 W4 写明的部门、责任人各自所在部门），每个部门各算一次；按部门图的合计因此可能大于风险条数。
 */
export function riskTallies(alerts: RiskAlertLike[], issues: RiskIssueLike[]) {
  const bySeverity: Record<RiskSeverity, number> = { RED: 0, YELLOW: 0, ISSUE_OVERDUE: 0, ISSUE_OPEN: 0 }
  const dept = new Map<string, number>()
  const add = (name: string) => dept.set(name, (dept.get(name) ?? 0) + 1)
  for (const a of alerts) {
    const s = alertSeverity(a)
    if (!s) continue
    bySeverity[s]++
    const names = [...new Set(a.deptNames.filter(Boolean))]
    if (!names.length) add(NO_DEPT)
    for (const n of names) add(n)
  }
  for (const i of issues) {
    const s = issueSeverity(i)
    if (!s) continue
    bySeverity[s]++
    add(i.deptGroup || NO_DEPT)
  }
  const byDept = [...dept].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { bySeverity, byDept, total: RISK_SEVERITIES.reduce((n, s) => n + bySeverity[s], 0) }
}

/** 时间按工厂时区显示 'MM-DD HH:mm'（服务端渲染和浏览器结果一致，不受浏览器时区影响） */
export function factoryTimeText(v: string | Date | null | undefined): string {
  if (!v) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(v))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** 时间按工厂时区显示 'YYYY-MM-DD HH:mm'（列表的发放时间、处理时间等；服务端渲染和浏览器一致） */
export function factoryDateTimeText(v: string | Date | null | undefined): string {
  if (!v) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(v))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}
