/** 工单交期预测汇总，复用节点估算与计划图口径。 */
import { dayDiff } from '../../../shared/dates'
import type { NodeFacts, PlanForecast } from './estimate-types'
import { estimateNodes, isDelayed } from './node-estimates'
import { lastTopNode } from './graph'
import { planDateConflicts } from './date-conflicts'

export function forecastPlan(nodes: NodeFacts[], deliveryDay: string, today: string, offDays: ReadonlySet<string> = new Set()): PlanForecast {
  const est = estimateNodes(nodes, today, deliveryDay, offDays)
  const dateConflicts = planDateConflicts(nodes, offDays, est)
  const conflictNodeIds = new Set(dateConflicts.map((conflict) => conflict.nodeId))
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
