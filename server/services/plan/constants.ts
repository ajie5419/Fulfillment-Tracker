/**
 * 项目部总计划（R14）的常量与纯函数：部门任务的预计日、节点预计完成日（沿前置节点顺延）、余量 / 关键节点、自动完成、预计交期、W9 判定。
 * 不碰数据库，便于单测。日期一律用 'YYYY-MM-DD' 字符串（日期字段存当天 UTC 零点，dateFieldDay 取出来），"今天"按工厂时区。
 *
 * 规则（总计划设计第 5 节）：
 *   部门任务的预计日：已完成取实际完成日；没完成的取它自己的日期（设计看计划完成日，设计完成等客户确认的看客户确认计划日；
 *     采购有承诺到货日看承诺日、否则看需求日；工序：厂外外协有承诺返回日看承诺返回日、否则看要求完成日；装配节点看需求日；其他任务看计划完成日），
 *     这个日期已经过了（还没完成）就按今天算。已取消的设计任务、采购行不计入。
 *   节点预计完成日 = 取最晚：节点自己的计划日；挂靠任务里最晚的预计日；各前置节点顺延后的日期（前置节点晚了几天，扣掉到本节点开始日之前的空档，本节点就晚几天；
 *     没自定前置的节点前置 = 上一个节点，没有开始日时空档为 0，和 R14 的"保持间隔顺延"一样）。
 *     没完成的节点预计日不早于今天（计划日已过还没完成，最早也只能今天完成）。
 *   节点完成：挂靠任务 ≥ 1 条（不算已取消的）且全部完成时自动完成，实际完成日 = 最晚的完成日；也可以手动标记（手动优先）。
 *     完成的节点预计日 = 实际完成日。
 *   预计交期 = 最后一个节点的预计日；与 QMS 交期比得出拖期天数。
 *   源头节点：不计前序顺延，节点自身（计划日 vs 挂靠任务预计日；计划日已过仍未完成且上游没把它推后时按今天）就已延误的没完成节点。
 *     只因上游顺延而延误的节点不是源头（页面标"受上游影响"）。
 *   W9（节点级，refType = planNode）：只报源头节点，级别按自身延误天数（≥ 黄阈值黄、≥ 红阈值红）。
 *   W9（工单级，refType = plan，refId = 工单号）：预计交期晚于 QMS 交期 → 红，发给项目经理、项目部负责人、分管领导。
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
/** W9 工单级：预计交期晚于合同交期 */
export const w9PlanKey = (workOrderNumber: string) => alertKey('W9', 'plan', workOrderNumber)

const maxDay = (a: string, b: string) => (a >= b ? a : b)

/** 'YYYY-MM-DD' 往后 n 天 */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

// ───────────── 部门任务 ─────────────

/** task = 其他任务（部门计划二次分解，plan_task）：4 类记录覆盖不到的部门工作 */
export type TaskKind = 'drawing' | 'purchase' | 'step' | 'assembly' | 'task'
export const TASK_KIND_TEXT: Record<TaskKind, string> = { drawing: '设计', purchase: '采购', step: '工序', assembly: '装配', task: '其他任务' }

/** 待办："完成部门任务"（refType = planTask，refId = 其他任务 ID），发给任务负责人，截止日 = 计划完成日 */
export const DO_PLAN_TASK = 'DO_PLAN_TASK'
export const PLAN_TASK_REF = 'planTask'
/** 以总计划节点为对象（refId = 节点 ID）的 W9 预警类型：节点延误、超时未确认、未分解。按节点找工单、跳转的地方都用这一份，加类型只改这里 */
export const PLAN_NODE_ALERT_REFS = ['planNode', 'planConfirm', 'planSplit'] as const
export const isPlanNodeAlert = (refType: string) => (PLAN_NODE_ALERT_REFS as readonly string[]).includes(refType)

/** W9"节点未分解"提醒（对象类型 planSplit，refId = 节点 ID） */
export const w9SplitKey = (nodeId: string) => alertKey('W9', 'planSplit', nodeId)

/** 一条挂靠任务的事实（由各类记录换算，见下面的 *Facts） */
export interface TaskFacts {
  kind: TaskKind
  id: string
  /** 不计入（已取消的设计任务、采购行） */
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

/** 设计任务：完成 = 已完成（设计完成、已发放、需要时客户已确认）；设计完成等客户确认的看客户确认计划日 */
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
 * 装配节点（齐套）：完成 = 清单不为空且全部就绪（齐套）。
 * 完成日 = 齐套日（最后一项就绪的那天：工件置为完成的时刻、物料到货日，见 kitting/constants.ts countKit），都是落了库的日期。
 * 以前齐套时刻没取，完成日按"需求日和今天较早的那个"现算，提前齐套的节点完成日会每天往后挪（项目日历的实际完成会跟着变），10-21 改为取记录日期。
 * 缺日期（老数据工件没有 statusSince 一般不会发生）时为 null，按"不知道完成日"处理（autoDone 按今天算，项目日历不计入实际完成）。
 */
export function assemblyFacts(n: { id: string; needDate: Date }, kit: { total: number; ready: number; readyDay?: string | null }, _today: string): TaskFacts {
  const need = day(n.needDate)!
  const done = kit.total > 0 && kit.ready >= kit.total
  return { kind: 'assembly', id: n.id, excluded: false, done, doneDay: done ? (kit.readyDay ?? null) : null, planDay: need }
}

/** 其他任务：完成 = 填了完成日；看计划完成日 */
export function planTaskFacts(t: { id: string; planDate: Date; doneDate: Date | null }): TaskFacts {
  return { kind: 'task', id: t.id, excluded: false, done: !!t.doneDate, doneDay: day(t.doneDate), planDay: day(t.planDate) }
}

// ───────────── 节点与前置关系 ─────────────

export interface NodeFacts {
  id: string
  planDay: string
  /** 计划开始日（可选）：有开始日时，前置节点晚到"开始日前一天"之前不推后（中间的空档是余量） */
  startDay?: string | null
  /** 前置节点 ID：null / 不填 = 默认（一级节点等上一个一级节点，子节点没有前置）；[] = 没有前置 */
  preds?: string[] | null
  /** 上级节点 ID（子节点；只有一层）：子节点都完成上级才算完成，子节点晚了上级跟着晚 */
  parent?: string | null
  /** 手动标记完成的完成日（没手动标记为 null） */
  manualDoneDay: string | null
  tasks: TaskFacts[]
}

export interface NodeEstimate {
  id: string
  done: boolean
  /** 怎么完成的：MANUAL 手动标记，AUTO 挂靠任务（和子节点）全部完成 */
  doneBy: 'MANUAL' | 'AUTO' | null
  actualDay: string | null
  expectedDay: string
  /** 预计日 - 计划日（天，正数 = 晚；完成的节点是 实际 - 计划） */
  delayDays: number
  /** 预计日由什么决定：self 自身计划日 / task 挂靠任务 / prev 前置节点顺延 / today 计划日已过 / actual 已完成 */
  driver: 'self' | 'task' | 'prev' | 'today' | 'actual'
  /** 不计前置顺延的自身预计日（完成的 = 实际完成日） */
  selfExpectedDay: string
  /** 自身延误天数 = 自身预计日 - 计划日（没完成且 > 0 才算源头） */
  selfDelayDays: number
  /** 自身预计日由什么决定：self / task / today / actual */
  selfDriver: 'self' | 'task' | 'today' | 'actual'
  /** 源头延误节点：没完成、自身就已延误 */
  source: boolean
  /** 受上游影响：没完成，且前置顺延后比自身预计日更晚 */
  upstream: boolean
  /** 实际用的前置节点 ID（默认的"上一个节点"也解析出来） */
  preds: string[]
  /** 推后是哪个前置节点（或子节点）造成的（driver = prev 时） */
  pushedBy: string | null
  /** 子节点 ID（按顺序） */
  children: string[]
  /**
   * 余量：这个节点还能再晚几天而不推迟预计交期（按前置关系从最后一个节点往前推）。
   * ≤ 0 = 关键节点（再晚就拖交期；负数 = 已经让交期晚了这么多天）；null = 已完成，或者后面没有节点接着它（不影响交期）。
   */
  slackDays: number | null
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

/**
 * 按层级排顺序：一级节点按原顺序，每个一级节点后面紧跟它的子节点（子节点之间按原顺序）。
 * 上级不在本计划里、或上级自己也是子节点的（只有一层，保存时就拦住了），当一级节点处理。
 */
export function treeOrder<T extends { id: string; parent?: string | null }>(nodes: T[]): T[] {
  const parentOf = parentsOf(nodes)
  const out: T[] = []
  for (const n of nodes) {
    if (parentOf.get(n.id)) continue
    out.push(n, ...nodes.filter((c) => parentOf.get(c.id) === n.id))
  }
  return out
}

/** 每个节点实际的上级（只认一层：上级不在本计划里、是自己、或上级自己也有上级的，当没有上级） */
export function parentsOf(nodes: { id: string; parent?: string | null }[]): Map<string, string | null> {
  const raw = new Map(nodes.map((n) => [n.id, n.parent ?? null]))
  const isTop = (id: string) => {
    const p = raw.get(id)
    return !p || p === id || !raw.has(p)
  }
  return new Map(nodes.map((n) => [n.id, !isTop(n.id) && isTop(n.parent!) ? n.parent! : null]))
}

/**
 * 解析每个节点自己的前置节点（不含子节点；nodes 按 treeOrder 排好）：
 *   preds 为 null / 不填 = 默认：一级节点等上一个一级节点；子节点没有前置（可以和兄弟子节点同时开始，10-23 zhao：
 *   延误只沿子节点自己的前置传，上级的前置不往下传——否则原材料晚了，同一上级下不等原材料的工艺、料单也被推后）。
 *   不在本计划里的 ID、自己、自己的上级丢掉（上级要等子节点，子节点再等上级就成环）。
 */
export function resolvePreds(nodes: Pick<NodeFacts, 'id' | 'preds' | 'parent'>[]): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id))
  const parentOf = parentsOf(nodes)
  const out = new Map<string, string[]>()
  let prevTop: string | null = null
  for (const n of nodes) {
    const parent = parentOf.get(n.id) ?? null
    let mine: string[]
    if (n.preds != null) mine = [...new Set(n.preds)].filter((p) => p !== n.id && p !== parent && ids.has(p))
    else if (parent) mine = []
    else mine = prevTop ? [prevTop] : []
    out.set(n.id, mine)
    if (!parent) prevTop = n.id
  }
  return out
}

/** 子节点表（上级 ID → 子节点 ID，按顺序） */
export function childrenOf(nodes: Pick<NodeFacts, 'id' | 'parent'>[]): Map<string, string[]> {
  const parentOf = parentsOf(nodes)
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  for (const n of nodes) {
    const p = parentOf.get(n.id)
    if (p) out.get(p)!.push(n.id)
  }
  return out
}

/** 能推后节点的那些节点：汇总行（有子节点）只看子节点，其余看前置（和 estimateNodes 一致） */
export const pushersOf = (e: Pick<NodeEstimate, 'preds' | 'children'>) => (e.children.length ? e.children : e.preds)

/**
 * 节点实际要等的节点（排拓扑顺序、查环用，和推后预计日的规则 pushersOf 一致）：
 * 有子节点的汇总行只等子节点（自己的前置不起作用，不算边）；其余等自己的前置。
 */
export function waitsOn(preds: Map<string, string[]>, children: Map<string, string[]>): Map<string, string[]> {
  return new Map([...preds].map(([id, ps]) => [id, pushersOf({ preds: ps, children: children.get(id) ?? [] })]))
}

/**
 * 拓扑顺序（前置在前，同层按原顺序）。有环时返回 null（保存时就拦住了，这里兜底）。
 */
export function topoOrder(ids: string[], preds: Map<string, string[]>): string[] | null {
  const indeg = new Map(ids.map((id) => [id, (preds.get(id) ?? []).length]))
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const id of ids) for (const p of preds.get(id) ?? []) succ.get(p)?.push(id)
  const out: string[] = []
  const ready = ids.filter((id) => indeg.get(id) === 0)
  const pos = new Map(ids.map((id, i) => [id, i]))
  while (ready.length) {
    ready.sort((a, b) => pos.get(a)! - pos.get(b)!)
    const id = ready.shift()!
    out.push(id)
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) ready.push(s)
    }
  }
  return out.length === ids.length ? out : null
}

/**
 * 前置节点 p 到节点 n 的"连接余量"：n 有计划开始日时，p 按计划完成到 n 开始前一天之间空出来的天数（p 晚这么多天以内不影响 n）；
 * 没有开始日时为 0（p 晚几天 n 就跟着晚几天，和原来的"保持间隔顺延"一样）。
 */
export function linkFloat(predPlanDay: string, startDay: string | null | undefined): number {
  if (!startDay) return 0
  return Math.max(0, dayDiff(predPlanDay, addDays(startDay, -1)))
}

/** 最后一个一级节点（对应工单交期；子节点不算） */
export function lastTopNode<T extends { id: string; parent?: string | null }>(nodes: T[]): T | undefined {
  const parentOf = parentsOf(nodes)
  return treeOrder(nodes).filter((n) => !parentOf.get(n.id)).at(-1)
}

/**
 * 算每个节点的预计日（nodes 按顺序号排好；输出顺序同输入）。
 * 只沿前置节点往后推：前置节点 p 晚了 d 天（预计 - 计划），扣掉连接余量后还晚的天数加到本节点计划日上；多个前置取最晚。
 * 没有自定前置的一级节点默认前置 = 上一个一级节点（和 R14 的一条主线一致）；子节点默认没有前置。
 * 有子节点的节点是汇总行（10-23 zhao：子任务是父任务的细分）：只被子节点推后（不早于最晚的子节点预计日，算"受上游影响"），
 * 自己的前置只当子节点的默认前置、不直接推它——这样原材料晚了只影响等原材料的下料、组焊，不会经"采购"汇总殃及别的；
 * 挂靠任务和子节点都完成才自动完成。
 * deliveryDay 给了时再从最后一个一级节点往前算余量（slackDays）。
 */
export function estimateNodes(input: NodeFacts[], today: string, deliveryDay?: string): NodeEstimate[] {
  const nodes = treeOrder(input)
  const ids = nodes.map((n) => n.id)
  let preds = resolvePreds(nodes)
  let kids = childrenOf(nodes)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const order = topoOrder(ids, waitsOn(preds, kids))
  // 兜底：有环时退回一条主线（不分上下级）
  if (!order) {
    preds = new Map(nodes.map((n, i) => [n.id, i > 0 ? [nodes[i - 1]!.id] : []]))
    kids = new Map(ids.map((id) => [id, []]))
  }
  const parentOf = new Map<string, string>()
  for (const [p, cs] of kids) for (const c of cs) parentOf.set(c, p)
  const est = new Map<string, NodeEstimate>()
  /** 前置 p 把 n 推到哪天（扣掉连接余量；可能早于 n 的计划日 = 不推）；p 是 n 的子节点时就是 p 的预计日 */
  const pushOf = (p: NodeEstimate, n: NodeFacts) => {
    if (parentOf.get(p.id) === n.id) return p.expectedDay
    const pPlan = byId.get(p.id)!.planDay
    return addDays(n.planDay, dayDiff(pPlan, p.expectedDay) - linkFloat(pPlan, n.startDay))
  }
  /** 能推后节点的：有子任务的父任务是汇总行，只看子任务（自己的前置只当子任务的默认前置，不直接推它）；其余看前置 */
  const pushers = (id: string) => pushersOf({ children: kids.get(id)!, preds: preds.get(id)! })
  for (const id of order ?? ids) {
    const n = byId.get(id)!
    const tasks = n.tasks.map((t) => ({ ...t, ...estimateTask(t, n.planDay, today) }))
    const counted = tasks.filter((t) => !t.excluded)
    const myKids = kids.get(id)!.map((c) => est.get(c)!)
    // 子节点当作挂靠任务一起算自动完成（完成日 = 子节点实际完成日）
    const auto = autoDone(
      [...n.tasks, ...myKids.map((c): TaskFacts => ({ kind: 'task', id: c.id, excluded: false, done: c.done, doneDay: c.actualDay, planDay: null }))],
      today,
    )
    const doneBy = n.manualDoneDay ? 'MANUAL' : auto.done ? 'AUTO' : null
    const actualDay = n.manualDoneDay ?? auto.day
    const myPreds = preds.get(id)!
    let expectedDay: string
    let driver: NodeEstimate['driver']
    let selfExpectedDay: string
    let selfDriver: NodeEstimate['selfDriver']
    let upstream = false
    let pushedBy: string | null = null
    if (actualDay) {
      expectedDay = selfExpectedDay = actualDay
      driver = selfDriver = 'actual'
    } else {
      // 自身：计划日、挂靠任务
      selfExpectedDay = n.planDay
      selfDriver = 'self'
      const taskMax = counted.map((t) => t.expectedDay).filter((d): d is string => !!d)
      if (taskMax.length) {
        const m = taskMax.reduce(maxDay)
        if (m > selfExpectedDay) [selfExpectedDay, selfDriver] = [m, 'task']
      }
      // 前置节点（和子节点）推到的最晚一天
      let shifted: string | null = null
      for (const p of pushers(id)) {
        const d = pushOf(est.get(p)!, n)
        if (!shifted || d > shifted) [shifted, pushedBy] = [d, p]
      }
      // 计划日已过仍未完成：前置没把它推到计划日之后时算自身的（否则是在等前置）
      if (today > selfExpectedDay && (!shifted || shifted <= n.planDay)) [selfExpectedDay, selfDriver] = [today, 'today']
      expectedDay = selfExpectedDay
      driver = selfDriver
      if (shifted && shifted > expectedDay) {
        ;[expectedDay, driver] = [shifted, 'prev']
        upstream = true
      } else pushedBy = null
      if (today > expectedDay) [expectedDay, driver, pushedBy] = [today, 'today', null]
    }
    const selfDelayDays = dayDiff(n.planDay, selfExpectedDay)
    est.set(id, {
      id,
      done: !!actualDay,
      doneBy,
      actualDay,
      expectedDay,
      delayDays: dayDiff(n.planDay, expectedDay),
      driver,
      selfExpectedDay,
      selfDelayDays,
      selfDriver,
      source: !actualDay && selfDelayDays > 0,
      upstream: !actualDay && upstream && dayDiff(n.planDay, expectedDay) > 0,
      preds: myPreds,
      pushedBy,
      children: kids.get(id)!,
      slackDays: null,
      taskCount: counted.length,
      doneCount: counted.filter((t) => t.done).length,
      overdueCount: counted.filter((t) => t.overdue).length,
      lateCount: counted.filter((t) => t.lateForNode).length,
      tasks,
    })
  }
  // 余量：最后一个一级节点 = 交期 - 预计日；往前每个节点取各后续节点（含上级）"连接上还能晚的天数 + 后续节点的余量"里最小的
  const last = order ? lastTopNode(nodes) : nodes.at(-1)
  if (deliveryDay && last) {
    const slack = new Map<string, number>()
    if (!est.get(last.id)!.done) slack.set(last.id, dayDiff(est.get(last.id)!.expectedDay, deliveryDay))
    const succ = new Map<string, string[]>(ids.map((id) => [id, []]))
    for (const id of ids) for (const p of pushers(id)) succ.get(p)!.push(id)
    for (const id of [...(order ?? ids)].reverse()) {
      const me = est.get(id)!
      if (id === last.id || me.done) continue
      let best: number | null = null
      for (const s of succ.get(id)!) {
        const ss = slack.get(s)
        if (ss == null || est.get(s)!.done) continue
        const v = dayDiff(pushOf(me, byId.get(s)!), est.get(s)!.expectedDay) + ss
        if (best == null || v < best) best = v
      }
      if (best != null) slack.set(id, best)
    }
    for (const [id, v] of slack) est.get(id)!.slackDays = v
  }
  return input.map((n) => est.get(n.id)!)
}

/**
 * 影响范围（10-23 zhao：建计划时就要知道缺什么影响什么）：每个节点晚了会一路推后哪些节点（沿前置、子节点 → 汇总行往后，直到最后），
 * 按输入顺序排。不在里面的节点不受它影响。
 */
export function downstreamOf(est: Pick<NodeEstimate, 'id' | 'preds' | 'children'>[]): Map<string, string[]> {
  const succ = new Map<string, string[]>(est.map((e) => [e.id, []]))
  for (const e of est) for (const p of pushersOf(e)) succ.get(p)?.push(e.id)
  const pos = new Map(est.map((e, i) => [e.id, i]))
  const out = new Map<string, string[]>()
  for (const e of est) {
    const seen = new Set<string>()
    const stack = [...succ.get(e.id)!]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id) || id === e.id) continue
      seen.add(id)
      stack.push(...succ.get(id)!)
    }
    out.set(e.id, [...seen].sort((a, b) => pos.get(a)! - pos.get(b)!))
  }
  return out
}

/** 关键节点：没完成、余量 ≤ 0（再晚就拖交期） */
export const isCritical = (n: Pick<NodeEstimate, 'done' | 'slackDays'>) => !n.done && n.slackDays != null && n.slackDays <= 0

export interface PlanForecast {
  nodes: NodeEstimate[]
  /** 对应交期的节点 = 最后一个一级节点 */
  lastNodeId: string | null
  /** 预计交期 = 最后一个一级节点的预计日；没有节点为 null */
  expectedDelivery: string | null
  /** 预计交期 - QMS 交期（天，正数 = 拖期）；没有节点为 null */
  deliveryDelayDays: number | null
  /** 延误节点：没完成、预计日晚于计划日（含只因前置顺延的） */
  delayedNodes: number
  /** 源头延误节点：没完成、自身就已延误（看板、总览、每日汇总的"延误节点数"按这个口径） */
  sourceNodes: number
}

export function forecastPlan(nodes: NodeFacts[], deliveryDay: string, today: string): PlanForecast {
  const est = estimateNodes(nodes, today, deliveryDay)
  const lastId = lastTopNode(nodes)?.id ?? null
  const last = est.find((e) => e.id === lastId)
  return {
    nodes: est,
    lastNodeId: lastId,
    expectedDelivery: last?.expectedDay ?? null,
    deliveryDelayDays: last ? dayDiff(deliveryDay, last.expectedDay) : null,
    delayedNodes: est.filter(isDelayed).length,
    sourceNodes: est.filter((n) => n.source).length,
  }
}

/** 延误节点：没完成、预计日晚于计划日 */
export const isDelayed = (n: Pick<NodeEstimate, 'done' | 'delayDays'>) => !n.done && n.delayDays > 0

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
  return elapsedMs >= remindHours * 3_600_000 ? 'REMIND' : null
}

/** 部门日期晚于节点日的提示（保存时返回给页面；只提示不拦截） */
export function lateWarning(what: string, recordDay: string | null, node: { name: string; planDay: string } | null): string | null {
  if (!node || !recordDay || recordDay <= node.planDay) return null
  return `${what} ${recordDay} 晚于总计划节点"${node.name}"的计划日 ${node.planDay}（晚 ${dayDiff(node.planDay, recordDay)} 天），已保存，总计划里会标红`
}

export type { BusinessDept }
