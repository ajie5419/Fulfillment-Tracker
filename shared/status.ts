/**
 * 全站状态色与状态归类：唯一来源（前端 app/ 与服务端 server/ 共用，纯数据 + 纯函数，不依赖任何运行时）。
 * 颜色口径（前端改版第一轮）：已完成 / 正常 绿，有风险 黄，受上游影响 橙，延误 红，未开始 / 未建计划 灰，按计划 主色蓝。
 * 状态永远同时给文字（或图标），不能只靠颜色区分。CSS 里同名变量在 app/assets/base.css（--ft-*），两处保持一致。
 * 前端用 #shared/status，服务端用相对路径引用。
 */

export const STATUS_COLOR = {
  /** 已完成 / 正常 */
  done: '#0ca30c',
  /** 有风险（黄） */
  risk: '#fab219',
  /** 受上游影响 */
  upstream: '#ec835a',
  /** 延误（红） */
  late: '#d03b3b',
  /** 未开始 / 未建计划 */
  none: '#b3bac6',
  /** 按计划进行中（主色） */
  onTrack: '#2a78d6',
} as const

/** 看板红黄绿（工单整体） */
export type BoardColorKey = 'RED' | 'YELLOW' | 'GREEN'
export const BOARD_COLOR: Readonly<Record<BoardColorKey, string>> = { RED: STATUS_COLOR.late, YELLOW: STATUS_COLOR.risk, GREEN: STATUS_COLOR.done }
export const BOARD_TEXT: Readonly<Record<BoardColorKey, string>> = { RED: '红', YELLOW: '黄', GREEN: '绿' }

// ───────────── 总计划节点状态 ─────────────

/**
 * 节点状态（总计划时间线、项目总览的节点圆点共用）：
 *   DONE 已完成；SOURCE 源头延误（自身就晚了）；UPSTREAM 受上游影响（只因前面节点顺延而晚）；ON_TRACK 按计划（还没完成、不晚）。
 */
export type NodeState = 'DONE' | 'SOURCE' | 'UPSTREAM' | 'ON_TRACK'
export const NODE_STATE_TEXT: Readonly<Record<NodeState, string>> = { DONE: '已完成', SOURCE: '源头延误', UPSTREAM: '受上游影响', ON_TRACK: '按计划' }
export const NODE_STATE_COLOR: Readonly<Record<NodeState, string>> = {
  DONE: STATUS_COLOR.done,
  SOURCE: STATUS_COLOR.late,
  UPSTREAM: STATUS_COLOR.upstream,
  ON_TRACK: STATUS_COLOR.onTrack,
}

/** 由总计划预计结果（server/services/plan/constants.ts 的 NodeEstimate）归类；源头优先于受上游影响 */
export function nodeState(n: { done: boolean; source: boolean; upstream: boolean }): NodeState {
  if (n.done) return 'DONE'
  if (n.source) return 'SOURCE'
  if (n.upstream) return 'UPSTREAM'
  return 'ON_TRACK'
}

/** 当前卡点 = 按主线顺序最早的源头延误节点；没有为 null */
export function stuckNode<T extends { seq: number; state: NodeState }>(nodes: T[]): T | null {
  return [...nodes].sort((a, b) => a.seq - b.seq).find((n) => n.state === 'SOURCE') ?? null
}

/** "谁在拖"：源头延误节点按责任部门汇总自身延误天数（天数多的在前，同天数按部门编码） */
export function lagByDept<D extends string>(nodes: { dept: D; state: NodeState; selfDelayDays: number }[]): { dept: D; days: number; nodes: number }[] {
  const m = new Map<D, { dept: D; days: number; nodes: number }>()
  for (const n of nodes) {
    if (n.state !== 'SOURCE') continue
    const row = m.get(n.dept) ?? { dept: n.dept, days: 0, nodes: 0 }
    row.days += Math.max(0, n.selfDelayDays)
    row.nodes++
    m.set(n.dept, row)
  }
  return [...m.values()].sort((a, b) => b.days - a.days || (a.dept < b.dept ? -1 : a.dept > b.dept ? 1 : 0))
}

/** 节点名称缩写（项目总览卡片的圆点下方）：去掉序号空白，最多 n 个字 */
export function shortName(name: string, n = 4): string {
  const s = name.trim()
  return s.length > n ? s.slice(0, n) : s
}

/**
 * 节点多时圆点只显示头尾、省略中间：返回要显示的下标，null 表示"…"。
 * 不超过 max 个时全显示；否则保留前 head 个、后 max - head - 1 个，中间一个省略号。卡点（keep）一定保留。
 */
export function compactIndexes(count: number, max = 7, keep: number | null = null): (number | null)[] {
  const all = Array.from({ length: count }, (_, i) => i)
  if (count <= max) return all
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  const shown = new Set([...all.slice(0, head), ...all.slice(count - tail)])
  if (keep != null && keep >= 0 && keep < count && !shown.has(keep)) {
    // 卡点在中间：替换头部最后一个，保证它能看到
    shown.delete(head - 1)
    shown.add(keep)
  }
  const out: (number | null)[] = []
  for (const i of all) {
    if (shown.has(i)) out.push(i)
    else if (out.at(-1) !== null) out.push(null)
  }
  return out
}

// ───────────── 项目总览分组 ─────────────

/** 项目总览按状态分组：预计拖期 / 有风险 / 正常 / 未建总计划（没有已发布的总计划） */
export type BoardGroup = 'LATE' | 'RISK' | 'OK' | 'NO_PLAN'
export const BOARD_GROUP_TEXT: Readonly<Record<BoardGroup, string>> = { LATE: '预计拖期', RISK: '有风险', OK: '正常', NO_PLAN: '未建总计划' }
export const BOARD_GROUP_COLOR: Readonly<Record<BoardGroup, string>> = { LATE: STATUS_COLOR.late, RISK: STATUS_COLOR.risk, OK: STATUS_COLOR.done, NO_PLAN: STATUS_COLOR.none }

/**
 * 分组规则：
 *   没有已发布总计划 → NO_PLAN（草稿不算，预计交期只按已发布的算）；
 *   预计交期晚于合同交期（拖期天数 > 0）→ LATE；
 *   有源头延误节点，或看板红 / 黄 → RISK；
 *   否则 OK。
 */
export function boardGroup(r: { hasPlan: boolean; delayDays: number | null; delayedPlanNodes: number; color: BoardColorKey }): BoardGroup {
  if (!r.hasPlan) return 'NO_PLAN'
  if ((r.delayDays ?? 0) > 0) return 'LATE'
  if (r.delayedPlanNodes > 0 || r.color !== 'GREEN') return 'RISK'
  return 'OK'
}

// ───────────── 工单详情"要处理的事" ─────────────

export interface ActionItem {
  kind: 'alert' | 'issue'
  /** RED / YELLOW / REMIND（预警）；异常：超期按红、其余按黄 */
  level: 'RED' | 'YELLOW' | 'REMIND'
  /** 超期天数等，用来同级排序（大的在前） */
  weight: number
}

const LEVEL_RANK = { RED: 0, YELLOW: 1, REMIND: 2 } as const

/** 按严重度排：红 → 黄 → 提醒；同级时 weight 大的在前，再预警在前 */
export function sortActions<T extends ActionItem>(items: T[]): T[] {
  return [...items].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.weight - a.weight || (a.kind === b.kind ? 0 : a.kind === 'alert' ? -1 : 1))
}
