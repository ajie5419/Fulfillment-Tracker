/**
 * 工单详情页的总计划时间线（甘特式）与交期对比条：刻度、位置的纯函数（不画图，只算百分比），便于单测。
 * 日期一律是服务端给的 'YYYY-MM-DD' 字符串，按 UTC 零点换算成天数，不受浏览器时区影响（服务端渲染和浏览器结果一致，不产生 hydration 差异）。
 */

const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' → 自 1970-01-01 起的天数 */
export function dayNum(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS)
}

/** 天数 → 'YYYY-MM-DD' */
export function numDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

export interface DayRange {
  /** 'YYYY-MM-DD' */
  start: string
  end: string
}

/**
 * 时间轴范围：覆盖所有给出的日期，两头各留 pad 天；总跨度至少 minSpan 天（不够时向后补）。
 * 没有任何日期时以 fallback 为中心。
 */
export function ganttRange(days: (string | null | undefined)[], fallback: string, pad = 5, minSpan = 30): DayRange {
  const ns = days.filter((d): d is string => !!d).map(dayNum)
  const lo = (ns.length ? Math.min(...ns) : dayNum(fallback)) - pad
  let hi = (ns.length ? Math.max(...ns) : dayNum(fallback)) + pad
  if (hi - lo < minSpan) hi = lo + minSpan
  return { start: numDay(lo), end: numDay(hi) }
}

/** 某天在时间轴上的位置（0–100，超出范围的夹到两端） */
export function pct(day: string, r: DayRange): number {
  const s = dayNum(r.start)
  const span = dayNum(r.end) - s
  if (span <= 0) return 0
  const v = ((dayNum(day) - s) / span) * 100
  return Math.round(Math.min(100, Math.max(0, v)) * 100) / 100
}

export interface MonthTick {
  /** 显示文字：'8 月'；跨年后的 1 月（或第一个刻度不在当年）带年份 */
  label: string
  left: number
}

/**
 * 月份刻度：范围内每个月 1 号一个刻度；月份太多时隔几个月显示一个（最多 maxTicks 个）。
 * 第一个刻度和跨年的 1 月带年份，其余只写月份。
 */
export function monthTicks(r: DayRange, maxTicks = 8): MonthTick[] {
  const [sy, sm] = r.start.split('-').map(Number) as [number, number]
  const endN = dayNum(r.end)
  const firsts: { y: number; m: number; day: string }[] = []
  let y = sy
  let m = sm + 1 // 范围开头所在月的下一个 1 号（开头当月的 1 号在范围外）
  if (r.start.endsWith('-01')) m = sm
  for (;;) {
    if (m > 12) {
      y++
      m -= 12
    }
    const day = `${y}-${String(m).padStart(2, '0')}-01`
    if (dayNum(day) > endN) break
    firsts.push({ y, m, day })
    m++
  }
  const step = Math.max(1, Math.ceil(firsts.length / maxTicks))
  const shown = firsts.filter((_, i) => i % step === 0)
  // 第一个刻度和跨年后的第一个刻度带年份（抽稀后 1 月可能被跳过）
  return shown.map((f, i) => ({ label: i === 0 || f.y !== shown[i - 1]!.y ? `${f.y} 年 ${f.m} 月` : `${f.m} 月`, left: pct(f.day, r) }))
}

export interface BarInput {
  /** 节点计划日 */
  planDay: string
  /** 节点预计 / 实际完成日 */
  endDay: string
}

export interface Bar {
  /** 计划区间（虚线框）：上一节点计划日 → 本节点计划日 */
  planFrom: string
  planTo: string
  /** 预计 / 实际区间（实心条）：上一节点预计（实际）日 → 本节点预计（实际）日 */
  from: string
  to: string
}

/**
 * 每个节点的计划区间和预计区间：节点只有一个计划日，区间按主线顺序从上一个节点接过来；第一个节点从 startDay 开始。
 * 起点晚于终点（顺序号和日期对不上时）夹成同一天，至少画一个点。
 */
export function nodeBars(nodes: BarInput[], startDay: string): Bar[] {
  let prevPlan = startDay
  let prevEnd = startDay
  return nodes.map((n) => {
    const planFrom = prevPlan <= n.planDay ? prevPlan : n.planDay
    const from = prevEnd <= n.endDay ? prevEnd : n.endDay
    prevPlan = n.planDay
    prevEnd = n.endDay
    return { planFrom, planTo: n.planDay, from, to: n.endDay }
  })
}

export interface DeliveryBar {
  /** 今天、合同交期、预计交期在条上的位置（0–100） */
  today: number
  delivery: number
  expected: number | null
  /** 已用工期占合同工期的百分比（开工 → 今天 ÷ 开工 → 合同交期，0–100 取整） */
  usedPercent: number
  /** 预计超出合同交期的天数（不超出为 0） */
  overDays: number
}

/** 交期对比条：开工 → 今天 → 合同交期；预计晚于合同交期时，超出部分画在合同交期右边（轴的终点 = 合同交期和预计交期里较晚的） */
export function deliveryBar(start: string, today: string, delivery: string, expected: string | null): DeliveryBar {
  const end = expected && expected > delivery ? expected : delivery
  const r: DayRange = { start, end: end > today ? end : today }
  const total = dayNum(delivery) - dayNum(start)
  const used = total > 0 ? Math.round((Math.min(Math.max(dayNum(today) - dayNum(start), 0), total) / total) * 100) : 100
  return {
    today: pct(today, r),
    delivery: pct(delivery, r),
    expected: expected ? pct(expected, r) : null,
    usedPercent: used,
    overDays: expected ? Math.max(0, dayNum(expected) - dayNum(delivery)) : 0,
  }
}
