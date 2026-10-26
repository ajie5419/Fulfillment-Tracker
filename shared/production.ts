/**
 * 生产管理重设计第一批（zhao 10-26 确认）的前端纯函数（前端 app/ 与单测共用，不依赖运行时）：
 *   生产调度的页签归类和每行的主按钮、工序编排的工件筛选 / 一句话状态 / 工序链色块。
 * 日期一律 'YYYY-MM-DD' 字符串比较，"今天"按工厂时区（Asia/Shanghai）由调用方传入。
 */

export type StepStatus = 'PENDING' | 'OUT' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED'
export type StepMode = 'SELF' | 'IN_PLANT_OUTSOURCE' | 'EXTERNAL_OUTSOURCE'
export type Tone = 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'

// ───────────── 生产调度 ─────────────

/** 服务端 listProduction 的列：可以开工 / 加工中 / 在外加工 / 卡住 / 近 7 天完成 */
export type ProductionColumn = 'ready' | 'working' | 'out' | 'stuck' | 'done'
export const COLUMN_TEXT: Readonly<Record<ProductionColumn, string>> = { ready: '可以开工', working: '加工中', out: '在外加工', stuck: '卡住', done: '近 7 天完成' }
export const COLUMN_TONE: Readonly<Record<ProductionColumn, Tone>> = { ready: 'none', working: 'primary', out: 'primary', stuck: 'upstream', done: 'done' }

/** 页签：可以开工 / 进行中（加工中 + 在外）/ 已超期 / 卡住 / 近 7 天完成 */
export type ProductionTab = 'ready' | 'active' | 'overdue' | 'stuck' | 'done'
export const PRODUCTION_TABS: readonly ProductionTab[] = ['ready', 'active', 'overdue', 'stuck', 'done']
export const TAB_TEXT: Readonly<Record<ProductionTab, string>> = { ready: '可以开工', active: '进行中', overdue: '已超期', stuck: '卡住', done: '近 7 天完成' }

export interface ProductionRowLike {
  column: ProductionColumn
  status: StepStatus
  mode: StepMode
  ownerId: string | null
  /** 要求完成日 / 承诺返回日已过几天 */
  overdueDays: number
  /** 应开工日已过几天（只算可以开工的） */
  startLateDays: number
}

/** 已超期：没完成，且要求完成日（在外看承诺返回日）已过，或可以开工了但应开工日已过 */
export const isOverdue = (r: ProductionRowLike) => r.column !== 'done' && (r.overdueDays > 0 || r.startLateDays > 0)

export function inTab(r: ProductionRowLike, tab: ProductionTab): boolean {
  switch (tab) {
    case 'ready':
      return r.column === 'ready'
    case 'active':
      return r.column === 'working' || r.column === 'out'
    case 'overdue':
      return isOverdue(r)
    case 'stuck':
      return r.column === 'stuck'
    case 'done':
      return r.column === 'done'
  }
}

export function tabCounts(rows: ProductionRowLike[]): Record<ProductionTab, number> {
  return Object.fromEntries(PRODUCTION_TABS.map((t) => [t, rows.filter((r) => inTab(r, t)).length])) as Record<ProductionTab, number>
}

/**
 * 工序提醒 / 预警跳到生产调度时先打开的页签（只是提示：页面拿 ?step= 找到这道工序后用 tabForRow 切到它实际所在的页签）。
 * 加工中（W10）："提醒"级在要求完成日之前发，工序在"进行中"；黄、红级时要求完成日已过，在"已超期"。
 */
export type AlertLevelLike = 'REMIND' | 'YELLOW' | 'RED'
export function stepLinkTab(status: StepStatus, level?: AlertLevelLike | null): ProductionTab {
  if (status === 'IN_PROGRESS' || status === 'OUT') return level === 'YELLOW' || level === 'RED' ? 'overdue' : 'active'
  if (status === 'BLOCKED') return 'stuck'
  if (status === 'DONE') return 'done'
  return 'ready'
}

/** 这道工序应该显示在哪个页签：提示的页签里有它就用提示的，没有就按页签顺序找第一个有它的（等变更、缺料的待开工工序在"卡住"） */
export function tabForRow(r: ProductionRowLike, hint: ProductionTab): ProductionTab {
  if (inTab(r, hint)) return hint
  return PRODUCTION_TABS.find((t) => inTab(r, t)) ?? hint
}

/** 手机"生产"的三段：能开工 / 在做 / 在外；卡住、完成的不在手机分段里 */
export type MobileSeg = 'ready' | 'working' | 'out'
export function segOfColumn(c: ProductionColumn): MobileSeg | null {
  return c === 'ready' || c === 'working' || c === 'out' ? c : null
}

/** 每行唯一的主按钮：没有负责人先指定；可以开工 → 厂外"发出"、其余"开工"；加工中 → "完工"；在外 → "登记返厂"；其余没有 */
export type PrimaryAction = 'assign' | 'send' | 'start' | 'finish' | 'return' | null
export const ACTION_TEXT: Readonly<Record<Exclude<PrimaryAction, null>, string>> = { assign: '指定负责人', send: '发出', start: '开工', finish: '完工', return: '登记返厂' }

export function primaryAction(r: Pick<ProductionRowLike, 'column' | 'mode' | 'ownerId' | 'status'>): PrimaryAction {
  if (r.column === 'ready') {
    if (!r.ownerId) return 'assign'
    return r.mode === 'EXTERNAL_OUTSOURCE' ? 'send' : 'start'
  }
  if (r.column === 'working') return 'finish'
  if (r.column === 'out') return 'return'
  return null
}

/** 工序操作弹窗需要的字段（StepActionHost） */
export interface ActionRow {
  stepId: string
  partName: string
  processName: string
  quantity: number
  /** 已完成 / 已返回数量 */
  doneQty: number
  supplierId: string | null
  ownerId: string | null
}

/** 主按钮需要的权限：指定负责人是"改工序"（route），其余是"登记开工完工"（stepAction） */
export const actionNeeds = (a: Exclude<PrimaryAction, null>): 'route' | 'stepAction' => (a === 'assign' ? 'route' : 'stepAction')

// ───────────── 工序编排 ─────────────

export interface StepLike {
  status: StepStatus
  mode: StepMode
  needsFill: boolean
  holdReleaseId?: string | null
  dueDate: string | Date | null
  promisedReturnDate: string | Date | null
}

export interface PartLike {
  status: 'ACTIVE' | 'DONE'
  steps: StepLike[]
}

const day = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '')

/** 工序是否超期（没完成且要求完成日已过；在外看承诺返回日） */
export function stepLate(s: StepLike, today: string): boolean {
  if (s.status === 'DONE') return false
  const d = day(s.status === 'OUT' && s.promisedReturnDate ? s.promisedReturnDate : s.dueDate)
  return !!d && d < today
}

/** 工序链色块：已完成 / 当前（第一道没完成的）/ 超期 / 有异常 / 未开始 */
export type ChainTone = 'done' | 'current' | 'late' | 'blocked' | 'todo'
export function chainTones(steps: StepLike[], today: string): ChainTone[] {
  const cur = steps.findIndex((s) => s.status !== 'DONE')
  return steps.map((s, i) => {
    if (s.status === 'DONE') return 'done'
    if (s.status === 'BLOCKED') return 'blocked'
    if (stepLate(s, today)) return 'late'
    if (i === cur || s.status === 'IN_PROGRESS' || s.status === 'OUT') return 'current'
    return 'todo'
  })
}

/** 工序编排的筛选：全部 / 未排工序 / 待补充（有工序缺负责人或外协厂）/ 已排好 */
export type RouteFilter = 'all' | 'none' | 'fill' | 'ok'
export const ROUTE_FILTER_TEXT: Readonly<Record<RouteFilter, string>> = { all: '全部', none: '未排工序', fill: '待补充', ok: '已排好' }
export function routeFilterOf(p: PartLike): Exclude<RouteFilter, 'all'> {
  if (!p.steps.length) return 'none'
  if (p.steps.some((s) => s.needsFill)) return 'fill'
  return 'ok'
}

/** 工件一行只放一个最要紧的状态：有异常 > 超期 > 未排工序 > 待补充 > 等变更 > 已完成 > 进行中 > 未开工 */
export function partHeadline(p: PartLike, today: string): { tone: Tone; text: string } {
  const steps = p.steps
  const blocked = steps.filter((s) => s.status === 'BLOCKED').length
  if (blocked) return { tone: 'late', text: `${blocked} 道有异常` }
  const late = steps.filter((s) => stepLate(s, today)).length
  if (late) return { tone: 'late', text: `${late} 道超期` }
  if (!steps.length) return { tone: 'risk', text: '未排工序' }
  const fill = steps.filter((s) => s.needsFill).length
  if (fill) return { tone: 'risk', text: `${fill} 道待补充` }
  if (steps.some((s) => s.holdReleaseId && s.status === 'PENDING')) return { tone: 'upstream', text: '等变更' }
  if (p.status === 'DONE' || steps.every((s) => s.status === 'DONE')) return { tone: 'done', text: '已完成' }
  if (steps.some((s) => s.status !== 'PENDING')) return { tone: 'primary', text: '进行中' }
  return { tone: 'none', text: '未开工' }
}
