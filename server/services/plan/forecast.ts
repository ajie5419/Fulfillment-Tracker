/** 工单交期预测汇总，复用节点估算与计划图口径。 */
import { dayDiff } from '../../../shared/dates'
import type { NodeFacts, PlanForecast } from './estimate-types'
import { estimateNodes, isDelayed } from './node-estimates'
import { childrenOf, lastTopNode, resolvePreds } from './graph'

export function forecastPlan(nodes: NodeFacts[], deliveryDay: string, today: string, published = true): PlanForecast {
  // Drafts describe an intended schedule, not execution commitments. Keep graph
  // structure for editing without aging dates or propagating execution delays.
  if (!published) {
    const preds = resolvePreds(nodes)
    const children = childrenOf(nodes)
    return {
      nodes: nodes.map(n => ({
        id: n.id, done: false, doneBy: null, actualDay: null,
        expectedDay: n.planDay, delayDays: 0, driver: 'self',
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
