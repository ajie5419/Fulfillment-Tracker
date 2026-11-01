/** 计划层级、前置关系、拓扑顺序与影响范围；不估算任务日期。 */
import { addDays, dayDiff } from '../../../shared/dates'
import type { NodeFacts, NodeEstimate } from './estimate-types'

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

/**
 * 大纲编号（10-23 zhao：页面要分清 1、2 级，和 MS Project 一样）：nodes 按 treeOrder 排好。
 * 用了阶段的计划：阶段 = 1 级（连续同一阶段的一级节点算一组，按出现顺序编 1、2…），一级节点 = 2 级（1.1、1.2），子节点 = 3 级（1.1.1）；
 * 没用阶段的：一级节点 1、2…，子节点 1.1、1.2…。没填阶段的节点夹在中间时自成一组（页面显示"未分阶段"）。
 */
export function outlineCodes(nodes: { id: string; parentId: string | null; phase: string | null }[]): Map<string, string> {
  const out = new Map<string, string>()
  const hasPhase = nodes.some((n) => n.phase)
  const childNo = new Map<string, number>()
  let top = 0
  let group = 0
  let inGroup = 0
  let prev: string | null = null
  for (const n of nodes) {
    if (n.parentId && out.has(n.parentId)) {
      const k = (childNo.get(n.parentId) ?? 0) + 1
      childNo.set(n.parentId, k)
      out.set(n.id, `${out.get(n.parentId)}.${k}`)
      continue
    }
    if (!hasPhase) {
      out.set(n.id, String(++top))
      continue
    }
    const ph = n.phase ?? null
    if (group === 0 || ph !== prev) {
      group++
      inGroup = 0
      prev = ph
    }
    out.set(n.id, `${group}.${++inGroup}`)
  }
  return out
}

/** 最后一个一级节点（对应工单交期；子节点不算） */
export function lastTopNode<T extends { id: string; parent?: string | null }>(nodes: T[]): T | undefined {
  const parentOf = parentsOf(nodes)
  return treeOrder(nodes).filter((n) => !parentOf.get(n.id)).at(-1)
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
