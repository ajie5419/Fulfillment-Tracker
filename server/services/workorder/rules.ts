/**
 * 工单详情（前端改版第一轮）的纯函数：选"总装"节点、缺件原因分布、挂靠记录跳转地址、部门记录的状态。
 * 不碰数据库，便于单测。
 */
import type { TaskKind } from '../plan/constants'

/**
 * 工单详情"总装齐套率"看哪个装配节点：名称含"总装"的（多个取需求日最晚的）；没有时取需求日最晚的节点；没有装配节点为 null。
 * needDay 为 'YYYY-MM-DD'。
 */
export function pickMainAssembly<T extends { name: string; needDay: string }>(nodes: T[]): T | null {
  if (!nodes.length) return null
  const latest = (xs: T[]) => xs.reduce((a, b) => (b.needDay > a.needDay ? b : a))
  const named = nodes.filter((n) => n.name.includes('总装'))
  return latest(named.length ? named : nodes)
}

/** 缺件原因分布：按原因文字计数，多的在前 */
export function reasonCounts(shortages: { reason: string }[]): { reason: string; count: number }[] {
  const m = new Map<string, number>()
  for (const s of shortages) m.set(s.reason, (m.get(s.reason) ?? 0) + 1)
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'zh-CN'))
}

/**
 * 挂靠记录跳到对应部门列表，带上工单筛选：设计、采购看该工单全部记录；工序到工件与工序链；装配节点定位到该节点。
 * （不带 ?id=：设计 / 采购的 ?id= 会直接弹编辑框，从详情页过去只是看）
 */
export function taskListLink(kind: TaskKind, workOrderNumber: string, id: string): string {
  const wo = encodeURIComponent(workOrderNumber)
  switch (kind) {
    case 'drawing':
      return `/drawings?wo=${wo}&view=all`
    case 'purchase':
      return `/purchases?wo=${wo}&view=all`
    case 'step':
      return `/parts?wo=${wo}`
    case 'assembly':
      return `/kitting?wo=${wo}&id=${encodeURIComponent(id)}`
  }
}

/** 挂靠记录的状态：DONE 已完成；OVERDUE 自己的日期已过还没完成；LATE 日期晚于节点计划日；EXCLUDED 已取消不计入；NORMAL 其他 */
export type TaskState = 'DONE' | 'OVERDUE' | 'LATE' | 'EXCLUDED' | 'NORMAL'

export function taskState(t: { done: boolean; excluded: boolean; overdue: boolean; lateForNode: boolean }): TaskState {
  if (t.excluded) return 'EXCLUDED'
  if (t.done) return 'DONE'
  if (t.overdue) return 'OVERDUE'
  if (t.lateForNode) return 'LATE'
  return 'NORMAL'
}

/** 采购行的付款情况（只给"已付 / 付款未付"，不给金额；没有付款申请为 null） */
export function paymentText(statuses: ('PENDING' | 'PAID' | 'ON_HOLD')[]): string | null {
  if (!statuses.length) return null
  return statuses.every((s) => s === 'PAID') ? '已付' : '付款未付'
}
