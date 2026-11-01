/** 将已加载的节点和任务换算成工单预测；不读写数据库。 */
import { dateFieldDay } from '../alerts/rules'
import { type NodeFacts, forecastPlan, treeOrder } from './constants'
import type { PlanSources } from './loaders'
import type { PlanData } from './types'
import { projectPlanTasks } from './projection'

const day = (d: Date) => dateFieldDay(d)

export function calculatePlans(sources: PlanSources): Map<string, PlanData> {
  const { nodes, deps, workOrders, plans, wos, today } = sources
  const tasks = projectPlanTasks(sources)
  const woOfNode = new Map(nodes.map((n) => [n.id, n.workOrderNumber]))
  const predsOf = new Map<string, string[]>()
  for (const d of deps) predsOf.set(d.nodeId, [...(predsOf.get(d.nodeId) ?? []), d.predId])
  for (const t of tasks) if (t.kind === 'step') t.link = `/parts?wo=${encodeURIComponent(woOfNode.get(t.nodeId) ?? '')}`
  const delivery = new Map(workOrders.map((w) => [w.workOrderNumber, day(w.deliveryDate)]))
  const statusOf = new Map(plans.map((p) => [p.workOrderNumber, p.status]))
  const publishedAtOf = new Map(plans.map((p) => [p.workOrderNumber, p.publishedAt]))
  const out = new Map<string, PlanData>()
  for (const wo of wos) {
    // 按层级排：一级节点按顺序号，子节点紧跟在上级后面
    const mine = treeOrder(nodes.filter((n) => n.workOrderNumber === wo).map((n) => ({ id: n.id, parent: n.parentId, n }))).map((x) => x.n)
    const myTasks = tasks.filter((t) => woOfNode.get(t.nodeId) === wo)
    const facts: NodeFacts[] = mine.map((n) => ({
      id: n.id,
      planDay: day(n.planDate),
      startDay: n.startDate ? day(n.startDate) : null,
      preds: n.customDeps ? (predsOf.get(n.id) ?? []) : null,
      parent: n.parentId,
      manualDoneDay: n.manualDoneAt && n.actualDate ? day(n.actualDate) : null,
      tasks: myTasks.filter((t) => t.nodeId === n.id).map((t) => t.facts),
    }))
    const deliveryDay = delivery.get(wo) ?? null
    const lastTop = mine.filter((n) => !n.parentId).at(-1)
    const lastPlanDay = lastTop ? day(lastTop.planDate) : null
    out.set(wo, {
      workOrderNumber: wo,
      status: statusOf.get(wo) ?? null,
      publishedAt: publishedAtOf.get(wo) ?? null,
      deliveryDay,
      nodes: mine,
      tasks: myTasks,
      forecast: forecastPlan(facts, deliveryDay ?? lastPlanDay ?? today, today),
    })
  }
  return out
}
