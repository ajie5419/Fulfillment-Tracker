/** 工单交期预测汇总，复用节点估算与计划图口径。 */
import { dayDiff } from '../../../shared/dates'
import type { NodeFacts, PlanForecast } from './estimate-types'
import { estimateNodes, isDelayed } from './node-estimates'
import { childrenOf, lastTopNode, resolvePreds } from './graph'
import { planDateConflicts } from './date-conflicts'

export function forecastPlan(nodes: NodeFacts[], deliveryDay: string, today: string, offDays: ReadonlySet<string> = new Set(), published = true): PlanForecast {
  const est = estimateNodes(nodes, today, deliveryDay, offDays)
  // Drafts still need schedule and historical-completion validation before publishing.
  const dateConflicts = planDateConflicts(nodes, offDays, est)
  const conflictNodeIds = new Set(dateConflicts.map((conflict) => conflict.nodeId))
  // Drafts describe an intended schedule, not execution commitments. Keep graph
  // structure for editing without aging dates or propagating execution delays.
  if (!published) {
    const preds = resolvePreds(nodes)
    const children = childrenOf(nodes)
    return {
      dateConflicts,
      nodes: nodes.map(n => ({
        ...(conflictNodeIds.has(n.id) ? { dateConflict: true } : {}),
        id: n.id, done: false, doneBy: null, actualDay: null,
        expectedDay: n.planDay, expectedStartDay: n.startDay ?? null, delayDays: 0, driver: 'self',
        selfExpectedDay: n.planDay, selfDelayDays: 0, selfDriver: 'self',
        source: false, upstream: false, preds: preds.get(n.id) ?? [],
        pushedBy: null, children: children.get(n.id) ?? [], slackDays: null,
        taskCount: n.tasks.filter(t => !t.excluded).length, doneCount: 0,
        overdueCount: 0, lateCount: 0,
        tasks: n.tasks.map(t => ({ ...t, expectedDay: t.planDay, overdue: false, lateForNode: false })),
      })),
      lastNodeId: lastTopNode(nodes)?.id ?? null,
      expectedDelivery: null, deliveryDelayDays: null, delayedNodes: 0, sourceNodes: 0,
    }
  }
  if (dateConflicts.length) for (const node of est) {
    node.slackDays = null
    // 计划级风险由 dateConflicts 承载；节点分类只标本节点的日期问题。
    if (conflictNodeIds.has(node.id)) node.dateConflict = true
  }
  const lastId = lastTopNode(nodes)?.id ?? null
  const last = est.find((e) => e.id === lastId)
  return {
    dateConflicts,
    nodes: est,
    lastNodeId: lastId,
    expectedDelivery: dateConflicts.length ? null : last?.expectedDay ?? null,
    deliveryDelayDays: last && !dateConflicts.length ? dayDiff(deliveryDay, last.expectedDay) : null,
    delayedNodes: est.filter(isDelayed).length,
    sourceNodes: est.filter((n) => n.source).length,
  }
}
