/**
 * 手机端（前端改版第二轮）：待办按截止日分组、状态色调。纯函数，不依赖运行时。
 * 日期一律用 'YYYY-MM-DD' 字符串比较；"今天"按工厂时区 Asia/Shanghai 算，不用浏览器本地时区。
 */

export const FACTORY_TZ = 'Asia/Shanghai'
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/** 工厂时区的日期 'YYYY-MM-DD'；已是 'YYYY-MM-DD' 的原样返回 */
export function factoryDay(v: string | Date, tz = FACTORY_TZ): string {
  if (typeof v === 'string' && DAY_RE.test(v)) return v
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v))
}

/** 'YYYY-MM-DD' 往后 n 天（按日历日算，与时区无关） */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** 本周最后一天（周日）；周一为一周第一天 */
export function weekEndDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay() // 0 = 周日
  return addDays(day, dow === 0 ? 0 : 7 - dow)
}

/** 截止日分组：已过期 / 今天 / 本周（明天到周日）/ 以后 / 未定截止日 */
export type DueGroup = 'OVERDUE' | 'TODAY' | 'WEEK' | 'LATER' | 'NONE'
export const DUE_GROUP_ORDER: DueGroup[] = ['OVERDUE', 'TODAY', 'WEEK', 'LATER', 'NONE']
export const DUE_GROUP_TEXT: Readonly<Record<DueGroup, string>> = { OVERDUE: '已过期', TODAY: '今天', WEEK: '本周', LATER: '以后', NONE: '未定截止日' }

export function dueGroup(due: string | null, today: string): DueGroup {
  if (!due) return 'NONE'
  if (due < today) return 'OVERDUE'
  if (due === today) return 'TODAY'
  if (due <= weekEndDay(today)) return 'WEEK'
  return 'LATER'
}

/** 按截止日分组，只返回有内容的组，组内按截止日从早到晚（同日保持原顺序） */
export function groupByDue<T>(items: T[], dueOf: (t: T) => string | null, today: string): { group: DueGroup; items: T[] }[] {
  const m = new Map<DueGroup, T[]>()
  for (const t of items) {
    const g = dueGroup(dueOf(t), today)
    m.set(g, [...(m.get(g) ?? []), t])
  }
  return DUE_GROUP_ORDER.filter((g) => m.has(g)).map((g) => ({
    group: g,
    items: [...m.get(g)!].sort((a, b) => (dueOf(a) ?? '').localeCompare(dueOf(b) ?? '')),
  }))
}

/** 顶部统计：总数、已过期、今天到期 */
export function dueStats<T>(items: T[], dueOf: (t: T) => string | null, today: string) {
  let overdue = 0
  let dueToday = 0
  for (const t of items) {
    const g = dueGroup(dueOf(t), today)
    if (g === 'OVERDUE') overdue++
    else if (g === 'TODAY') dueToday++
  }
  return { total: items.length, overdue, dueToday }
}

/**
 * 待办的截止日：总计划节点用计划日期（服务端给的 'YYYY-MM-DD'），其余用 dueAt（按工厂时区取日期）；都没有为 null。
 */
export function todoDueDay(t: { dueAt?: string | Date | null; plan?: { planDate?: string | null } | null }): string | null {
  if (t.plan?.planDate) return t.plan.planDate
  return t.dueAt ? factoryDay(t.dueAt) : null
}

/**
 * 待办卡片的主操作按钮文字，与 pages/m/index.vue 的 open() 分支一一对应；不能在手机上处理的给 null（只显示提示）。
 */
export function todoPrimaryLabel(t: {
  action: string
  plan?: unknown
  release?: unknown
  step?: { status: string; mode: string } | null
}): string | null {
  if (t.plan) return null
  if (t.release) return t.action === 'CONFIRM_CHANGE' ? '去确认' : '去签收'
  if (!t.step) return null
  const ready = t.action === 'READY_TO_START' && t.step.status === 'PENDING'
  if (t.action === 'ARRANGE_SEND' || (ready && t.step.mode === 'EXTERNAL_OUTSOURCE')) return '登记发出'
  if (t.action === 'ARRANGE_START' || ready) return '开工'
  return null
}

// ───────────── 状态色调 ─────────────

/** 色调：与 assets/base.css 的 --ft-* 状态色对应（late 红、risk 黄、upstream 受上游影响、done 绿、none 灰、primary 主色） */
export type Tone = 'late' | 'risk' | 'upstream' | 'done' | 'none' | 'primary'

/** Vant 标签类型 → 色调 */
export function toneOfVant(type: string | null | undefined): Tone {
  return ({ danger: 'late', warning: 'risk', success: 'done', primary: 'primary' } as Record<string, Tone>)[type ?? ''] ?? 'none'
}

/** 色调 → 状态图标形状（components/ui/StatusIcon 的 kind），形状本身也区分状态，不只靠颜色 */
export const TONE_ICON: Readonly<Record<Tone, 'alert' | 'warn' | 'check' | 'ring' | 'dot'>> = {
  late: 'alert',
  risk: 'warn',
  upstream: 'warn',
  done: 'check',
  none: 'ring',
  primary: 'dot',
}

/** 截止日分组 → 色调 */
export const DUE_GROUP_TONE: Readonly<Record<DueGroup, Tone>> = { OVERDUE: 'late', TODAY: 'risk', WEEK: 'primary', LATER: 'none', NONE: 'none' }
