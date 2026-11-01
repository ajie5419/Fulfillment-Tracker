/** 节点自动完成、前置顺延与余量；纯函数，不访问数据库。 */
import { addDays, dayDiff } from '../../../shared/dates'
import type { TaskFacts, NodeFacts, NodeEstimate } from './estimate-types'
import { estimateTask } from './task-estimates'
import { treeOrder, resolvePreds, childrenOf, topoOrder, waitsOn, pushersOf, linkFloat, lastTopNode } from './graph'

const maxDay = (a: string, b: string) => (a >= b ? a : b)

/** 节点是否自动完成：计入的挂靠任务 ≥ 1 且全部完成；完成日 = 最晚的完成日（不知道的按今天） */
export function autoDone(tasks: TaskFacts[], today: string): { done: boolean; day: string | null } {
  const counted = tasks.filter((t) => !t.excluded)
  if (!counted.length || !counted.every((t) => t.done)) return { done: false, day: null }
  return { done: true, day: counted.map((t) => t.doneDay ?? today).reduce(maxDay) }
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

/** 关键节点：没完成、余量 ≤ 0（再晚就拖交期） */
export const isCritical = (n: Pick<NodeEstimate, 'done' | 'slackDays'>) => !n.done && n.slackDays != null && n.slackDays <= 0

/** 延误节点：没完成、预计日晚于计划日 */
export const isDelayed = (n: Pick<NodeEstimate, 'done' | 'delayDays'>) => !n.done && n.delayDays > 0
