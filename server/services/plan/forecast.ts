/** 工单交期预测汇总，复用节点估算与计划图口径。 */
import { dayDiff } from '../../../shared/dates'
import type { NodeFacts, PlanForecast } from './estimate-types'
import { estimateNodes, isDelayed } from './node-estimates'
import { lastTopNode } from './graph'

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
