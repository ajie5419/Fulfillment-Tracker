/**
 * 项目部总计划（R14）的常量与纯函数：部门任务的预计日、节点预计完成日（顺延）、自动完成、预计交期、W9 判定。
 * 不碰数据库，便于单测。日期一律用 'YYYY-MM-DD' 字符串（日期字段存当天 UTC 零点，dateFieldDay 取出来），"今天"按工厂时区。
 *
 * 规则（总计划设计第 5 节）：
 *   部门任务的预计日：已完成取实际完成日；没完成的取它自己的日期（出图看计划完成日，已出图等客户确认的看客户确认计划日；
 *     采购有承诺到货日看承诺日、否则看需求日；工序：厂外外协有承诺返回日看承诺返回日、否则看要求完成日；装配节点看需求日），
 *     这个日期已经过了（还没完成）就按今天算。已取消的出图任务、采购行不计入。
 *   节点预计完成日 = 取最晚：节点自己的计划日；挂靠任务里最晚的预计日；前一个节点顺延后的日期（前一节点预计日 + 原来两节点计划日的间隔）。
 *     没完成的节点预计日不早于今天（计划日已过还没完成，最早也只能今天完成）。
 *   节点完成：挂靠任务 ≥ 1 条（不算已取消的）且全部完成时自动完成，实际完成日 = 最晚的完成日；也可以手动标记（手动优先）。
 *     完成的节点预计日 = 实际完成日。
 *   预计交期 = 最后一个节点的预计日；与 QMS 交期比得出拖期天数。
 *   W9：没完成的节点预计日晚于计划日 ≥ 黄阈值天 → 黄；≥ 红阈值天，或预计交期晚于 QMS 交期 → 红。
 */
import type { AlertLevel, BusinessDept, DrawingTaskStatus, PlanNodeConfirm, PurchaseStatus, StepMode, StepStatus } from '@prisma/client'
import { type RuleThreshold, alertKey, dayDiff } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'

/** 待办："确认总计划节点"（refType = planNode，refId = 节点 ID），发给节点责任部门负责人 */
export const CONFIRM_PLAN_NODE = 'CONFIRM_PLAN_NODE'
export const PLAN_REF = 'planNode'

export const PLAN_DEPT_TEXT = BUSINESS_DEPT_NAME
export const CONFIRM_TEXT: Record<PlanNodeConfirm, string> = { PENDING: '待确认', CONFIRMED: '已确认', REJECTED: '已退回' }

/** 总计划页：选中工单并定位到节点 */
export const planLink = (workOrderNumber: string, nodeId?: string | null) =>
  `/plan?wo=${encodeURIComponent(workOrderNumber)}${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ''}`

/** W9 节点延误预警 / 节点超时未确认（同一规则，不同对象类型；超时未确认按 W5 的阈值计时） */
export const w9Key = (nodeId: string) => alertKey('W9', 'planNode', nodeId)
export const w9ConfirmKey = (nodeId: string) => alertKey('W9', 'planConfirm', nodeId)

const maxDay = (a: string, b: string) => (a >= b ? a : b)
const minDay = (a: string, b: string) => (a <= b ? a : b)

/** 'YYYY-MM-DD' 往后 n 天 */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

// ───────────── 部门任务 ─────────────

export type TaskKind = 'drawing' | 'purchase' | 'step' | 'assembly'
export const TASK_KIND_TEXT: Record<TaskKind, string> = { drawing: '出图', purchase: '采购', step: '工序', assembly: '装配' }

/** 一条挂靠任务的事实（由各类记录换算，见下面的 *Facts） */
export interface TaskFacts {
  kind: TaskKind
  id: string
  /** 不计入（已取消的出图任务、采购行） */
  excluded: boolean
  done: boolean
  /** 完成日（done 时；不知道时为 null，按今天算） */
  doneDay: string | null
  /** 部门自己的日期（比节点日、算预计日用）；工序没填要求完成日时为 null */
  planDay: string | null
}

export interface TaskEstimate {
  /** 预计（完成）日：已完成 = 完成日；没完成 = 自己的日期，已过按今天；没有日期为 null（不影响节点预计日） */
  expectedDay: string | null
  /** 没完成且自己的日期已过 */
  overdue: boolean
  /** 部门日期晚于节点计划日（只提示不拦截，总计划页标红） */
  lateForNode: boolean
}

export function estimateTask(t: TaskFacts, nodePlanDay: string, today: string): TaskEstimate {
  const lateForNode = !t.excluded && !!t.planDay && t.planDay > nodePlanDay
  if (t.excluded) return { expectedDay: null, overdue: false, lateForNode: false }
  if (t.done) return { expectedDay: t.doneDay ?? today, overdue: false, lateForNode }
  if (!t.planDay) return { expectedDay: null, overdue: false, lateForNode }
  const overdue = t.planDay < today
  return { expectedDay: overdue ? today : t.planDay, overdue, lateForNode }
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

/** 出图任务：完成 = 已完成（已出图、已发放、需要时客户已确认）；已出图等客户确认的看客户确认计划日 */
export function drawingFacts(
  d: { id: string; status: DrawingTaskStatus; planDate: Date; drawnDate: Date | null; needsCustomerConfirm: boolean; customerPlanDate: Date | null; customerConfirmedDate: Date | null },
): TaskFacts {
  const waitingCustomer = !!d.drawnDate && d.needsCustomerConfirm && !d.customerConfirmedDate && !!d.customerPlanDate
  return {
    kind: 'drawing',
    id: d.id,
    excluded: d.status === 'CANCELLED',
    done: d.status === 'DONE',
    doneDay: day(d.customerConfirmedDate) ?? day(d.drawnDate),
    planDay: waitingCustomer ? day(d.customerPlanDate) : day(d.planDate),
  }
}

/** 采购行：完成 = 已到货；有承诺到货日看承诺日，否则看需求日 */
export function purchaseFacts(l: { id: string; status: PurchaseStatus; needDate: Date; promisedDate: Date | null; arrivedDate: Date | null }): TaskFacts {
  return {
    kind: 'purchase',
    id: l.id,
    excluded: l.status === 'CANCELLED',
    done: l.status === 'ARRIVED',
    doneDay: day(l.arrivedDate),
    planDay: day(l.promisedDate) ?? day(l.needDate),
  }
}

/** 工序：完成 = 已完成（完成日按工厂时区）；厂外外协有承诺返回日看承诺返回日，否则看要求完成日 */
export function stepFacts(
  s: { id: string; status: StepStatus; mode: StepMode; dueDate: Date | null; promisedReturnDate: Date | null; finishedAt: Date | null },
  toShanghaiDay: (t: Date) => string,
): TaskFacts {
  const promised = s.mode === 'EXTERNAL_OUTSOURCE' ? day(s.promisedReturnDate) : null
  return {
    kind: 'step',
    id: s.id,
    excluded: false,
    done: s.status === 'DONE',
    doneDay: s.finishedAt ? toShanghaiDay(s.finishedAt) : null,
    planDay: promised ?? day(s.dueDate),
  }
}

/**
 * 装配节点（齐套）：完成 = 清单不为空且全部就绪（齐套）。齐套的时刻不落库，完成日取 需求日 和 今天 里较早的那个
 * （提前齐套的不会把节点完成日推到未来；过了需求日才齐的按需求日算——齐套本身不会让节点晚于需求日）。
 */
export function assemblyFacts(n: { id: string; needDate: Date }, kit: { total: number; ready: number }, today: string): TaskFacts {
  const need = day(n.needDate)!
  const done = kit.total > 0 && kit.ready >= kit.total
  return { kind: 'assembly', id: n.id, excluded: false, done, doneDay: done ? minDay(need, today) : null, planDay: need }
}

// ───────────── 节点与主线 ─────────────

export interface NodeFacts {
  id: string
  planDay: string
  /** 手动标记完成的完成日（没手动标记为 null） */
  manualDoneDay: string | null
  tasks: TaskFacts[]
}

export interface NodeEstimate {
  id: string
  done: boolean
  /** 怎么完成的：MANUAL 手动标记，AUTO 挂靠任务全部完成 */
  doneBy: 'MANUAL' | 'AUTO' | null
  actualDay: string | null
  expectedDay: string
  /** 预计日 - 计划日（天，正数 = 晚；完成的节点是 实际 - 计划） */
  delayDays: number
  /** 预计日由什么决定：self 自身计划日 / task 挂靠任务 / prev 前一节点顺延 / today 计划日已过 / actual 已完成 */
  driver: 'self' | 'task' | 'prev' | 'today' | 'actual'
  /** 计入的挂靠任务数（不含已取消）、其中完成的、超期的、日期晚于节点的 */
  taskCount: number
  doneCount: number
  overdueCount: number
  lateCount: number
  tasks: (TaskFacts & TaskEstimate)[]
}

/** 节点是否自动完成：计入的挂靠任务 ≥ 1 且全部完成；完成日 = 最晚的完成日（不知道的按今天） */
export function autoDone(tasks: TaskFacts[], today: string): { done: boolean; day: string | null } {
  const counted = tasks.filter((t) => !t.excluded)
  if (!counted.length || !counted.every((t) => t.done)) return { done: false, day: null }
  return { done: true, day: counted.map((t) => t.doneDay ?? today).reduce(maxDay) }
}

/** 按主线顺序（nodes 已按 seq 排好）算每个节点的预计日 */
export function estimateNodes(nodes: NodeFacts[], today: string): NodeEstimate[] {
  const out: NodeEstimate[] = []
  let prev: { planDay: string; expectedDay: string } | null = null
  for (const n of nodes) {
    const tasks = n.tasks.map((t) => ({ ...t, ...estimateTask(t, n.planDay, today) }))
    const counted = tasks.filter((t) => !t.excluded)
    const auto = autoDone(n.tasks, today)
    const doneBy = n.manualDoneDay ? 'MANUAL' : auto.done ? 'AUTO' : null
    const actualDay = n.manualDoneDay ?? auto.day
    let expectedDay: string
    let driver: NodeEstimate['driver']
    if (actualDay) {
      expectedDay = actualDay
      driver = 'actual'
    } else {
      expectedDay = n.planDay
      driver = 'self'
      const taskMax = counted.map((t) => t.expectedDay).filter((d): d is string => !!d)
      if (taskMax.length) {
        const m = taskMax.reduce(maxDay)
        if (m > expectedDay) [expectedDay, driver] = [m, 'task']
      }
      if (prev) {
        const shifted = addDays(prev.expectedDay, dayDiff(prev.planDay, n.planDay))
        if (shifted > expectedDay) [expectedDay, driver] = [shifted, 'prev']
      }
      if (today > expectedDay) [expectedDay, driver] = [today, 'today']
    }
    out.push({
      id: n.id,
      done: !!actualDay,
      doneBy,
      actualDay,
      expectedDay,
      delayDays: dayDiff(n.planDay, expectedDay),
      driver,
      taskCount: counted.length,
      doneCount: counted.filter((t) => t.done).length,
      overdueCount: counted.filter((t) => t.overdue).length,
      lateCount: counted.filter((t) => t.lateForNode).length,
      tasks,
    })
    prev = { planDay: n.planDay, expectedDay }
  }
  return out
}

export interface PlanForecast {
  nodes: NodeEstimate[]
  /** 预计交期 = 最后一个节点的预计日；没有节点为 null */
  expectedDelivery: string | null
  /** 预计交期 - QMS 交期（天，正数 = 拖期）；没有节点为 null */
  deliveryDelayDays: number | null
  /** 延误节点：没完成、预计日晚于计划日 */
  delayedNodes: number
}

export function forecastPlan(nodes: NodeFacts[], deliveryDay: string, today: string): PlanForecast {
  const est = estimateNodes(nodes, today)
  const last = est.at(-1)
  return {
    nodes: est,
    expectedDelivery: last?.expectedDay ?? null,
    deliveryDelayDays: last ? dayDiff(deliveryDay, last.expectedDay) : null,
    delayedNodes: est.filter(isDelayed).length,
  }
}

/** 延误节点：没完成、预计日晚于计划日 */
export const isDelayed = (n: Pick<NodeEstimate, 'done' | 'delayDays'>) => !n.done && n.delayDays > 0

// ───────────── W9 ─────────────

/**
 * W9 总计划节点延误：只看没完成的节点。晚 ≥ 红阈值天，或（节点在延误且）预计交期晚于 QMS 交期 → 红；晚 ≥ 黄阈值天 → 黄。
 */
export function judgeW9(n: Pick<NodeEstimate, 'done' | 'delayDays'>, deliveryLate: boolean, t: RuleThreshold): AlertLevel | null {
  if (!isDelayed(n)) return null
  if (n.delayDays >= t.redDays || deliveryLate) return 'RED'
  if (n.delayDays >= t.yellowDays) return 'YELLOW'
  return null
}

const DRIVER_TEXT = { self: '', task: '部门任务延误', prev: '前序节点顺延', today: '计划日已过仍未完成', actual: '' } as const

/** W9 提醒标题里冒号后面的部分 */
export function w9Summary(n: Pick<NodeEstimate, 'expectedDay' | 'delayDays' | 'driver'>, planDay: string, delivery: { expected: string | null; delayDays: number | null }): string {
  const why = DRIVER_TEXT[n.driver]
  const tail = delivery.delayDays != null && delivery.delayDays > 0 ? `；预计交期 ${delivery.expected}，拖期 ${delivery.delayDays} 天` : ''
  return `计划 ${planDay}，预计 ${n.expectedDay} 完成，晚 ${n.delayDays} 天${why ? `（${why}）` : ''}${tail}`
}

/** 部门日期晚于节点日的提示（保存时返回给页面；只提示不拦截） */
export function lateWarning(what: string, recordDay: string | null, node: { name: string; planDay: string } | null): string | null {
  if (!node || !recordDay || recordDay <= node.planDay) return null
  return `${what} ${recordDay} 晚于总计划节点"${node.name}"的计划日 ${node.planDay}（晚 ${dayDiff(node.planDay, recordDay)} 天），已保存，总计划页会标红`
}

export type { BusinessDept }
