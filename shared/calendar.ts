/**
 * 项目日历（按周 / 按月统计计划完成台数、实际完成台数）的纯函数：前端翻页和服务端统计共用，不依赖任何运行时。
 * 日期一律是工厂时区（北京时间）的 'YYYY-MM-DD'；周 = 周一到周日。
 *
 * 口径（zhao 10-21 定）：
 *   "完成" = 总计划的发运节点（最后一个节点）完成；台数取 QMS 工单数量。
 *   计划完成日：有已发布总计划的取最后一个节点的当前计划日；没有（或还是草稿）的取 QMS 交期。
 *   实际完成日：最后一个节点的完成日（手动标记或挂靠任务全部完成）；没有已发布总计划的工单系统里没有完成日，不计入实际。
 *   逾期未完成：计划完成日在本期、已过（早于今天）、还没完成；没有总计划的判断不了，单列"未排总计划"。
 */

export type CalendarView = 'week' | 'month'

export interface Period {
  view: CalendarView
  /** 第一天、最后一天（含） */
  start: string
  end: string
  /** 显示用："10月" / "10/19–10/25" */
  label: string
}

const DAY_MS = 86_400_000
const ms = (day: string) => Date.parse(`${day}T00:00:00.000Z`)
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10)
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`

export function addDay(day: string, n: number): string {
  return fmt(ms(day) + n * DAY_MS)
}

/** 某天所在的周（周一开始）或月 */
export function periodOf(view: CalendarView, day: string): Period {
  if (view === 'week') {
    const dow = (new Date(ms(day)).getUTCDay() + 6) % 7 // 周一 0 … 周日 6
    const start = addDay(day, -dow)
    const end = addDay(start, 6)
    return { view, start, end, label: `${md(start)}–${md(end)}` }
  }
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  const start = `${day.slice(0, 7)}-01`
  const end = fmt(Date.UTC(y, m, 0)) // 下个月第 0 天 = 本月最后一天
  return { view, start, end, label: `${m}月` }
}

/** 往前 / 往后翻 n 期 */
export function shiftPeriod(p: Period, n: number): Period {
  if (p.view === 'week') return periodOf('week', addDay(p.start, n * 7))
  const y = Number(p.start.slice(0, 4))
  const m = Number(p.start.slice(5, 7)) - 1 + n
  return periodOf('month', fmt(Date.UTC(y, m, 1)))
}

export const inPeriod = (p: Pick<Period, 'start' | 'end'>, day: string | null | undefined): day is string => !!day && day >= p.start && day <= p.end

/** 月历格子：从本月第一天所在周的周一，到最后一天所在周的周日；周视图就是这 7 天 */
export function gridDays(p: Period): string[] {
  const first = periodOf('week', p.start).start
  const last = periodOf('week', p.end).end
  const out: string[] = []
  for (let d = first; d <= last; d = addDay(d, 1)) out.push(d)
  return out
}

/** 一个工单的完成情况（统计用的最小字段） */
export interface CompletionLike {
  /** QMS 工单数量（台）；QMS 没填时为 0 */
  quantity: number
  /** 计划完成日 */
  planDay: string
  /** 计划完成日从哪来：PLAN = 已发布总计划的最后一个节点；DELIVERY = QMS 交期（没有已发布总计划） */
  source: 'PLAN' | 'DELIVERY'
  done: boolean
  /** 实际完成日（只有 source = PLAN 且已完成时有） */
  actualDay: string | null
}

export interface Tally {
  /** 工单数 */
  orders: number
  /** 台数（QMS 数量之和） */
  units: number
}

export interface PeriodSummary {
  /** 计划完成日在本期 */
  planned: Tally
  /** 实际完成日在本期（不管计划在哪一期） */
  actual: Tally
  /** 计划在本期、已过、还没完成（只算有已发布总计划的） */
  overdue: Tally
  /** 计划在本期、没有已发布总计划（按 QMS 交期计入计划，实际完成判断不了） */
  noPlan: Tally
  /** 计划在本期、QMS 数量为 0 的工单数（台数没法算，提醒去 QMS 补） */
  missingQuantity: number
}

const units = (q: number) => Math.max(0, q)

export function summarize(items: readonly CompletionLike[], p: Pick<Period, 'start' | 'end'>, today: string): PeriodSummary {
  const t = (): Tally => ({ orders: 0, units: 0 })
  const s: PeriodSummary = { planned: t(), actual: t(), overdue: t(), noPlan: t(), missingQuantity: 0 }
  const add = (x: Tally, q: number) => {
    x.orders++
    x.units += units(q)
  }
  for (const c of items) {
    if (inPeriod(p, c.planDay)) {
      add(s.planned, c.quantity)
      if (c.quantity <= 0) s.missingQuantity++
      if (c.source === 'DELIVERY') add(s.noPlan, c.quantity)
      else if (!c.done && c.planDay < today) add(s.overdue, c.quantity)
    }
    if (c.done && inPeriod(p, c.actualDay)) add(s.actual, c.quantity)
  }
  return s
}

/** 完成情况的状态（列表、日历格子里的标签） */
export type CompletionState = 'DONE' | 'OVERDUE' | 'PENDING' | 'NO_PLAN'
export const COMPLETION_STATE_TEXT: Readonly<Record<CompletionState, string>> = { DONE: '已完成', OVERDUE: '逾期未完成', PENDING: '未完成', NO_PLAN: '未排总计划' }

export function completionState(c: Pick<CompletionLike, 'source' | 'done' | 'planDay'>, today: string): CompletionState {
  if (c.source === 'DELIVERY') return 'NO_PLAN'
  if (c.done) return 'DONE'
  return c.planDay < today ? 'OVERDUE' : 'PENDING'
}
