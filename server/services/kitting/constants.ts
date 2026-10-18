/**
 * 齐套（R12）的常量与纯函数：齐套率、工件就绪判定、缺件"卡在哪一步"、W8 判定。不碰数据库，便于单测。
 *
 * 规则从简：
 *   齐套率 = 已就绪项 ÷ 应有项；已取消的物料不计入应有项；清单为空的节点没有齐套率（不算未齐套，也不预警）。
 *   工件就绪 = 工件已完成（part.status = DONE：最后一道工序完成时 flow.ts 置 DONE，沿用系统现有的工件完成判定）。
 *   物料就绪 = 已到货（ARRIVED）。
 */
import type { AlertLevel, PartStatus, PurchaseStatus, StepStatus } from '@prisma/client'
import { type RuleThreshold, dateFieldDay, dayDiff, shanghaiDay } from '../alerts/rules'
import { lineProgress } from '../purchases/constants'
import { PRODUCTION_DEPT } from '../releases/constants'

/** 默认负责人：节点没指定负责人时是生产经理（生产部负责人）；W8 黄色起通知它的负责人 */
export const KITTING_DEPT = PRODUCTION_DEPT

export const kittingLink = (id: string) => `/kitting?id=${encodeURIComponent(id)}`
/** 手机端：带 id 时页面顶部单独展示这个节点（被升级通知的人也能看到，按能否看到该工单判权限） */
export const kittingMobileLink = (id: string) => `/m/kitting?id=${encodeURIComponent(id)}`

// ───────────── 就绪判定 ─────────────

/** 工件就绪：沿用系统现有的工件完成判定（part.status = DONE） */
export const isPartReady = (p: { status: PartStatus }) => p.status === 'DONE'

/** 物料是否计入应有项：已取消的不计 */
export const isPurchaseCounted = (l: { status: PurchaseStatus }) => l.status !== 'CANCELLED'

export const isPurchaseReady = (l: { status: PurchaseStatus }) => l.status === 'ARRIVED'

export interface KitCount {
  /** 应有项（工件 + 未取消的物料） */
  total: number
  /** 已就绪项 */
  ready: number
}

/** 齐套率（0–100 的整数，向下取整：差一项时不会显示成 100%）；清单为空为 null */
export function kitPercent(c: KitCount): number | null {
  if (!c.total) return null
  return Math.floor((c.ready * 100) / c.total)
}

/** 未齐套：有应有项且没全部就绪 */
export const isIncomplete = (c: KitCount) => c.total > 0 && c.ready < c.total

/** 节点清单计数 */
export function countKit(parts: { status: PartStatus }[], purchases: { status: PurchaseStatus }[]): KitCount {
  const counted = purchases.filter(isPurchaseCounted)
  return {
    total: parts.length + counted.length,
    ready: parts.filter(isPartReady).length + counted.filter(isPurchaseReady).length,
  }
}

// ───────────── 缺件卡在哪一步 ─────────────

export type BlockerCode =
  | 'NO_ROUTE' // 还没排工序
  | 'HOLD' // 等变更（R9）
  | 'DRAWING' // 图纸未完成（R11）
  | 'MATERIAL' // 待料（R10）
  | 'BLOCKED' // 有异常（检验不合格）
  | 'OUT' // 外协中
  | 'IN_PROGRESS' // 在制
  | 'PENDING' // 待开工
  | 'STEPS_DONE' // 工序都完成了，但工件还没置为完成（极少见）

export const BLOCKER_TEXT: Record<BlockerCode, string> = {
  NO_ROUTE: '未排工序',
  HOLD: '等变更',
  DRAWING: '图纸未完成',
  MATERIAL: '待料',
  BLOCKED: '有异常',
  OUT: '外协中',
  IN_PROGRESS: '在制',
  PENDING: '待开工',
  STEPS_DONE: '工序已完成',
}

export interface PartFacts {
  /** 工序链（任意顺序） */
  steps: { seq: number; status: StepStatus; processName: string; holdReleaseNo?: string | null; held: boolean }[]
  /** 关联的未完成（未取消）出图任务的部件名称 */
  openDrawings: string[]
  /** 挂在这个工件上、还没到货（未取消）的关键物料名称 */
  openMaterials: string[]
}

export interface PartBlocker {
  code: BlockerCode
  text: string
  /** 当前工序名（第一道未完成的工序）；没有工序为 null */
  stage: string | null
  /** 补充说明，如"主梁总图"、"钢板、回转支承"、发放单号 */
  detail: string | null
}

const list = (xs: string[], max = 3) => (xs.length > max ? `${xs.slice(0, max).join('、')} 等 ${xs.length} 项` : xs.join('、'))

/**
 * 未就绪工件卡在哪一步，只给一个主要原因：
 *   当前工序（第一道未完成的）有异常 → 有异常；外协中 / 在制 → 照实写（已经在动了，其余原因次要）；
 *   当前工序还没开工（或还没排工序）时，依次看：等变更 → 图纸未完成 → 待料 → 待开工 / 未排工序。
 */
export function partBlocker(f: PartFacts): PartBlocker {
  const steps = [...f.steps].sort((a, b) => a.seq - b.seq)
  const cur = steps.find((s) => s.status !== 'DONE') ?? null
  const stage = cur?.processName ?? null
  const make = (code: BlockerCode, detail: string | null = null): PartBlocker => ({ code, text: BLOCKER_TEXT[code], stage, detail })
  if (steps.length && !cur) return make('STEPS_DONE')
  if (cur?.status === 'BLOCKED') return make('BLOCKED')
  if (cur?.status === 'OUT') return make('OUT')
  if (cur?.status === 'IN_PROGRESS') return make('IN_PROGRESS')
  if (cur?.held) return make('HOLD', cur.holdReleaseNo ?? null)
  if (f.openDrawings.length) return make('DRAWING', list(f.openDrawings))
  if (f.openMaterials.length) return make('MATERIAL', list(f.openMaterials))
  return cur ? make('PENDING') : make('NO_ROUTE')
}

export interface MaterialShortage {
  /** 列表上的状态（缺料 / 超承诺日 / 待到货 / 无承诺日，同采购到货页） */
  text: string
  /** 逾期：已过承诺到货日或物料需求日 */
  overdue: boolean
  /** 赶不上节点：承诺到货日晚于节点需求日，或没有承诺日且节点需求日已到 */
  lateForNode: boolean
}

export function materialShortage(l: { status: PurchaseStatus; needDate: Date; promisedDate: Date | null }, nodeNeedDate: Date, now: Date): MaterialShortage {
  const p = lineProgress({ ...l, arrivedDate: null }, now)
  const nodeNeed = dateFieldDay(nodeNeedDate)
  const lateForNode = l.promisedDate ? dateFieldDay(l.promisedDate) > nodeNeed : nodeNeed <= shanghaiDay(now)
  return { text: p.text, overdue: p.late, lateForNode }
}

// ───────────── W8 ─────────────

export interface W8Input extends KitCount {
  needDate: Date
  now: Date
}

export interface W8Result {
  level: AlertLevel | null
  /** 距需求日还有几天（自然日，已过为负） */
  daysLeft: number
}

/**
 * W8 装配节点未齐套（只看清单不为空、齐套率 < 100% 的节点）：
 *   距需求日 ≤ 红阈值天数（默认 1：前一天、当天、已过）→ 红；≤ 黄阈值天数（默认 5）→ 黄。
 * 与 W7 的"计划完成日前 N 天"一样按自然日，不扣停工日（停工日只暂停超期计时，这里没有超期计时）。不转异常。
 */
export function judgeW8(input: W8Input, t: RuleThreshold): W8Result {
  const daysLeft = dayDiff(shanghaiDay(input.now), dateFieldDay(input.needDate))
  if (!isIncomplete(input)) return { level: null, daysLeft }
  if (daysLeft <= t.redDays) return { level: 'RED', daysLeft }
  if (daysLeft <= t.yellowDays) return { level: 'YELLOW', daysLeft }
  return { level: null, daysLeft }
}

/** 需求日文案：需求日 10-25（还剩 3 天 / 就是今天 / 已过 2 天） */
export function needText(needDate: Date, daysLeft: number): string {
  const when = daysLeft > 0 ? `还剩 ${daysLeft} 天` : daysLeft === 0 ? '就是今天' : `已过 ${-daysLeft} 天`
  return `需求日 ${dateFieldDay(needDate)}（${when}）`
}

/** W8 提醒标题里冒号后面的部分 */
export function w8Summary(r: W8Result, node: { needDate: Date }, c: KitCount, ownerName: string): string {
  return `${needText(node.needDate, r.daysLeft)}，齐套 ${c.ready}/${c.total}（${kitPercent(c)}%），缺 ${c.total - c.ready} 项（${ownerName}）`
}
