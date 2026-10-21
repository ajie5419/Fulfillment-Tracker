/**
 * 项目日历：按周 / 按月看计划完成台数、实际完成台数，以及每个工单的计划完成日。口径见 shared/calendar.ts。
 * 可见范围：所有登录用户看全部工单（zhao 10-21 定"不分权限"）；日历只给工单号、项目、客户、台数、日期和状态，不含金额。
 * 日历上点工单跳工单详情（/wo/:no），详情页仍按原来的可见范围判断。
 * 完成情况与总计划页同源（loadPlans → forecast），只看已发布的总计划（草稿不算，和看板、领导总览一致）。
 * 10-21 第三轮：页面不再显示中间节点，接口去掉 nodes。
 */
import { prisma } from '../../utils/prisma'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { loadPlans } from '../plan/plan'
import { stableDoneDay } from './rules'
import {
  type CalendarView,
  type CompletionLike,
  type CompletionState,
  type Period,
  type PeriodSummary,
  completionState,
  inPeriod,
  periodOf,
  shiftPeriod,
  summarize,
} from '../../../shared/calendar'

export interface Completion extends CompletionLike {
  workOrderNumber: string
  projectName: string | null
  customerName: string
  /** 预计完成日（有总计划、没完成时按总计划推算；完成的 = 实际完成日） */
  expectedDay: string | null
  /** QMS 合同交期 */
  deliveryDay: string
  /** 最后一个节点叫什么（一般是"发运"）；没有总计划为 null */
  nodeName: string | null
  nodeId: string | null
  state: CompletionState
}

/** 全部有效工单（没删除、没取消）的完成情况 */
async function loadAll(now: Date) {
  const today = shanghaiDay(now)
  const [wos, plans] = await Promise.all([
    prisma.qmsWorkOrder.findMany({
      where: { isDeleted: false, status: { not: 'CANCELLED' } },
      select: { workOrderNumber: true, projectName: true, customerName: true, quantity: true, deliveryDate: true },
      orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    }),
    loadPlans({ publishedOnly: true }, now),
  ])
  const completions: Completion[] = []
  for (const w of wos) {
    const plan = plans.get(w.workOrderNumber)
    const deliveryDay = dateFieldDay(w.deliveryDate)
    const last = plan?.nodes.at(-1)
    const lastEst = plan && last ? plan.forecast.nodes.find((x) => x.id === last.id) : undefined
    const base = { workOrderNumber: w.workOrderNumber, projectName: w.projectName, customerName: w.customerName, quantity: w.quantity, deliveryDay }
    if (plan && last && lastEst) {
      const c = {
        ...base,
        planDay: dateFieldDay(last.planDate),
        source: 'PLAN' as const,
        done: lastEst.done,
        // 只认落库的完成日（见 rules.ts）；自动完成但日期会变的算已完成、不计入实际完成台数
        actualDay: stableDoneDay(lastEst, plan.tasks.filter((t) => t.nodeId === last.id).map((t) => t.facts)),
        expectedDay: lastEst.expectedDay,
        nodeName: last.name,
        nodeId: last.id,
      }
      completions.push({ ...c, state: completionState(c, today) })
    } else {
      const c = { ...base, planDay: deliveryDay, source: 'DELIVERY' as const, done: false, actualDay: null, expectedDay: null, nodeName: null, nodeId: null }
      completions.push({ ...c, state: completionState(c, today) })
    }
  }
  return { today, completions }
}

/** 前后几期的趋势：本期往前 2 期、往后 3 期 */
const TREND_BEFORE = 2
const TREND_AFTER = 3

export interface CalendarData {
  today: string
  period: Period
  summary: PeriodSummary
  trend: { period: Period; summary: PeriodSummary }[]
  /** 计划完成日在本期涉及的整周里（月视图含首尾跨月的几天，列表按整周分组要用）、或实际完成在本期的工单（按计划完成日排） */
  completions: Completion[]
}

export async function getCalendar(view: CalendarView, day: string | null, now = new Date()): Promise<CalendarData> {
  const { today, completions } = await loadAll(now)
  const period = periodOf(view, day ?? today)
  const grid = { start: periodOf('week', period.start).start, end: periodOf('week', period.end).end }
  const trend = Array.from({ length: TREND_BEFORE + TREND_AFTER + 1 }, (_, i) => {
    const p = shiftPeriod(period, i - TREND_BEFORE)
    return { period: p, summary: summarize(completions, p, today) }
  })
  return {
    today,
    period,
    summary: summarize(completions, period, today),
    trend,
    completions: completions.filter((c) => inPeriod(grid, c.planDay) || (c.done && inPeriod(period, c.actualDay))).sort((a, b) => (a.planDay < b.planDay ? -1 : a.planDay > b.planDay ? 1 : 0)),
  }
}

/** 工作台卡片：本周、下周、本月 */
export async function getCalendarSummary(now = new Date()) {
  const { today, completions } = await loadAll(now)
  const week = periodOf('week', today)
  const periods = [
    { key: 'thisWeek', title: '本周', period: week },
    { key: 'nextWeek', title: '下周', period: shiftPeriod(week, 1) },
    { key: 'thisMonth', title: '本月', period: periodOf('month', today) },
  ] as const
  return { today, items: periods.map((p) => ({ ...p, summary: summarize(completions, p.period, today) })) }
}
