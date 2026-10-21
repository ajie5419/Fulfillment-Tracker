/**
 * 项目日历：按周 / 按月看计划完成台数、实际完成台数，以及这一期到期的总计划节点。口径见 shared/calendar.ts。
 * 可见范围：所有登录用户看全部工单（zhao 10-21 定"不分权限"）；日历只给工单号、项目、客户、台数、节点日期和状态，不含金额。
 * 日历上点工单 / 节点跳工单详情（/wo/:no#node-:id），详情页仍按原来的可见范围判断。
 * 节点状态与总计划页同源（loadPlans → forecast），只看已发布的总计划（草稿不算，和看板、领导总览一致）。
 */
import { prisma } from '../../utils/prisma'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { loadPlans } from '../plan/plan'
import { type NodeState, nodeState } from '../../../shared/status'
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

export interface CalendarNode {
  id: string
  workOrderNumber: string
  projectName: string | null
  name: string
  dept: keyof typeof BUSINESS_DEPT_NAME
  deptText: string
  planDay: string
  actualDay: string | null
  expectedDay: string
  delayDays: number
  state: NodeState
  /** 是总计划最后一个节点（完成 = 工单完成，日历上显示台数） */
  isLast: boolean
  quantity: number
}

/** 全部有效工单（没删除、没取消）的完成情况 + 已发布总计划的节点 */
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
  const nodes: CalendarNode[] = []
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
        actualDay: lastEst.actualDay,
        expectedDay: lastEst.expectedDay,
        nodeName: last.name,
        nodeId: last.id,
      }
      completions.push({ ...c, state: completionState(c, today) })
      plan.nodes.forEach((n, i) => {
        const e = plan.forecast.nodes.find((x) => x.id === n.id)!
        nodes.push({
          id: n.id,
          workOrderNumber: w.workOrderNumber,
          projectName: w.projectName,
          name: n.name,
          dept: n.dept,
          deptText: BUSINESS_DEPT_NAME[n.dept],
          planDay: dateFieldDay(n.planDate),
          actualDay: e.actualDay,
          expectedDay: e.expectedDay,
          delayDays: e.delayDays,
          state: nodeState(e),
          isLast: i === plan.nodes.length - 1,
          quantity: w.quantity,
        })
      })
    } else {
      const c = { ...base, planDay: deliveryDay, source: 'DELIVERY' as const, done: false, actualDay: null, expectedDay: null, nodeName: null, nodeId: null }
      completions.push({ ...c, state: completionState(c, today) })
    }
  }
  return { today, completions, nodes }
}

/** 前后几期的趋势：本期往前 2 期、往后 3 期 */
const TREND_BEFORE = 2
const TREND_AFTER = 3

export interface CalendarData {
  today: string
  period: Period
  summary: PeriodSummary
  trend: { period: Period; summary: PeriodSummary }[]
  /** 计划或实际完成在本期的工单（按计划完成日排） */
  completions: Completion[]
  /** 计划日在本期的总计划节点（按日期、工单号、顺序排） */
  nodes: CalendarNode[]
}

export async function getCalendar(view: CalendarView, day: string | null, now = new Date()): Promise<CalendarData> {
  const { today, completions, nodes } = await loadAll(now)
  const period = periodOf(view, day ?? today)
  const trend = Array.from({ length: TREND_BEFORE + TREND_AFTER + 1 }, (_, i) => {
    const p = shiftPeriod(period, i - TREND_BEFORE)
    return { period: p, summary: summarize(completions, p, today) }
  })
  return {
    today,
    period,
    summary: summarize(completions, period, today),
    trend,
    completions: completions.filter((c) => inPeriod(period, c.planDay) || (c.done && inPeriod(period, c.actualDay))).sort((a, b) => (a.planDay < b.planDay ? -1 : a.planDay > b.planDay ? 1 : 0)),
    nodes: nodes.filter((n) => inPeriod(period, n.planDay)).sort((a, b) => (a.planDay < b.planDay ? -1 : a.planDay > b.planDay ? 1 : a.workOrderNumber < b.workOrderNumber ? -1 : a.workOrderNumber > b.workOrderNumber ? 1 : 0)),
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
