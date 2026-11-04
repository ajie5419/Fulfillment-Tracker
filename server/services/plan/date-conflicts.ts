import { nextFactoryWorkDay } from '../../../shared/dates'
import type { PlanDateConflict } from '../../../shared/plan-schedule'
import type { NodeFacts, NodeEstimate } from './estimate-types'
import { childrenOf, resolvePreds, topoOrder, treeOrder, waitsOn } from './graph'

export function planDateConflicts(input: NodeFacts[], offDays: ReadonlySet<string> = new Set(), estimates: NodeEstimate[] = []): PlanDateConflict[] {
  const nodes = treeOrder(input)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const estimated = new Map(estimates.map((node) => [node.id, node]))
  const preds = resolvePreds(nodes)
  const kids = childrenOf(nodes)
  const edges = waitsOn(preds, kids)
  const conflicts: PlanDateConflict[] = []
  const label = (node: NodeFacts) => node.name ?? node.id
  const add = (node: NodeFacts, code: PlanDateConflict['code'], message: string, extra: Partial<PlanDateConflict> = {}) => {
    conflicts.push({ code, nodeId: node.id, nodeName: label(node), startDay: node.startDay, message, blocksPublish: true, ...extra })
  }
  if (!topoOrder(nodes.map((node) => node.id), edges) && nodes[0]) add(nodes[0], 'CYCLE', '前置关系成环，日期预测待核实')
  for (const node of nodes) {
    if (node.startDay && node.startDay > node.planDay) add(node, 'DATE_ORDER', `“${label(node)}”开始 ${node.startDay} 晚于计划完成 ${node.planDay}`)
    if (kids.get(node.id)?.length) continue
    const predecessors = preds.get(node.id) ?? []
    if (!node.startDay && predecessors.length) add(node, 'MISSING_START', `“${label(node)}”计划完成 ${node.planDay}，缺少开始日期，无法核实前置完成→开始及工期`)
    for (const predId of predecessors) {
      const pred = byId.get(predId)
      if (!pred) continue
      const earliest = nextFactoryWorkDay(pred.planDay, offDays)
      if (node.startDay && node.startDay < earliest) {
        add(node, 'FS_ORDER', `“${label(node)}”开始 ${node.startDay} 早于前置“${label(pred)}”完成 ${pred.planDay} 后的下一工厂工作日 ${earliest}`, { predecessorId: predId, predecessorDay: pred.planDay })
      }
      const actual = estimated.get(node.id)
      const upstream = estimated.get(predId)
      if (actual?.done && upstream && (!upstream.done || (actual.actualDay ?? actual.expectedDay) < nextFactoryWorkDay(upstream.actualDay ?? upstream.expectedDay, offDays))) {
        add(node, 'ACTUAL_ORDER', `“${label(node)}”已完成 ${actual.actualDay}，但前置“${label(pred)}”${upstream.done ? `实际完成 ${upstream.actualDay}` : '尚未完成'}；保留实际日期，请核实依赖或历史记录`, { predecessorId: predId, predecessorDay: upstream.actualDay ?? upstream.expectedDay })
      }
    }
  }
  return conflicts
}
