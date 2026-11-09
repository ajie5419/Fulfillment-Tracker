import { addDays, dayDiff } from '../../../shared/dates'
import { childrenOf, resolvePreds, topoOrder, treeOrder, waitsOn } from './graph'
import { FlowError } from '../flow/errors'

export interface ScheduleNode {
  id: string
  name: string
  parent: string | null
  preds: string[] | null
  start: string | null
  finish: string
  done: boolean
}

/** Only changed dependency paths propagate. Existing slack is consumed before moving
 * unfinished successors; earlier finishes never pull an agreed schedule forward.
 * A missing start is treated as a one-day milestone, not an invented duration.
 */
export function linkSchedule(input: ScheduleNode[], editedId: string) {
  const nodes = treeOrder(input.map((n) => ({ ...n })))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const node = (id: string) => {
    const found = byId.get(id)
    if (!found) throw new FlowError('计划节点已变化，请刷新后重试')
    return found
  }
  const children = childrenOf(nodes)
  const waits = waitsOn(resolvePreds(nodes), children)
  const order = topoOrder(nodes.map((n) => n.id), waits)
  if (!order) throw new FlowError('前置关系存在循环，无法联动日期')
  const changed = new Set([editedId])
  const skipped: string[] = []
  for (const id of order) {
    if (id === editedId) continue
    const deps = waits.get(id) ?? []
    if (!deps.some((p) => changed.has(p))) continue
    const n = node(id)
    if (n.done) { skipped.push(n.name); continue }
    const kids = children.get(id) ?? []
    let start = n.start
    let finish = n.finish
    if (kids.length) {
      const rows = kids.map(node)
      finish = rows.map((k) => k.finish).reduce((a, b) => a > b ? a : b)
      start = rows.map((k) => k.start ?? k.finish).reduce((a, b) => a < b ? a : b)
      if (start === finish) start = null
    } else {
      const earliest = addDays(deps.map((p) => node(p).finish).reduce((a, b) => a > b ? a : b), 1)
      const previousStart = n.start ?? n.finish
      if (earliest > previousStart) {
        finish = addDays(n.finish, dayDiff(previousStart, earliest))
        start = n.start ? earliest : null
      }
    }
    if (start !== n.start || finish !== n.finish) {
      n.start = start
      n.finish = finish
      changed.add(id)
    }
  }
  return { nodes, skipped }
}
