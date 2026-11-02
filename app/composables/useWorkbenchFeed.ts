import { computed, type Ref } from 'vue'
import { groupByBucket, type WorkBucket } from '#shared/workbench'
import type { useTodos } from './useFlow'
import type { ReminderItem, useReminders } from './useReminders'

/** GET /api/todos 的一条待办 */
export type WorkbenchTodo = Awaited<ReturnType<typeof useTodos>>['data']['value'][number]
type RemindersData = NonNullable<Awaited<ReturnType<typeof useReminders>>['data']['value']>

// ───── 卡片流（分组见 shared/workbench.ts workBucket：只按真实截止日，没有的归"未定截止日"） ─────
export type Tone = 'late' | 'risk' | 'normal'
export interface Card {
  key: string
  kind: 'todo' | 'reminder'
  bucket: WorkBucket
  tone: Tone
  title: string
  wo: string | null
  dueDay: string | null
  createdAt: string
  unread: boolean
  todo?: WorkbenchTodo
  reminder?: ReminderItem
}
const TONE_RANK: Record<Tone, number> = { late: 0, risk: 1, normal: 2 }

export const WORKBENCH_FILTERS = ['todo', 'overdue', 'today', 'unread'] as const
export type WorkbenchFilter = (typeof WORKBENCH_FILTERS)[number]
export const WORKBENCH_FILTER_TEXT: Record<WorkbenchFilter, string> = { todo: '我的待办', overdue: '已过期', today: '今天到期', unread: '未读提醒' }

export const toneIcon = (t: Tone) => (t === 'late' ? 'alert' : t === 'risk' ? 'warn' : 'dot')
/** 待办的"查看"跳转：工序 → 工件抽屉（工序编排页）；发放 → 发放单；总计划 → 工单详情的总计划页签 */
export function todoLink(t: WorkbenchTodo): string | null {
  if (t.link) return t.link
  if (t.plan) return t.plan.link
  if (t.planTask) return t.planTask.link
  if (t.release) return `/releases?id=${encodeURIComponent(t.release.id)}`
  // 工序 / 工件待办：打开工件抽屉（生产管理重设计第一批）
  const partId = t.step?.partId ?? (t.refType === 'part' ? t.refId : null)
  if (t.workOrderNumber && partId) return `/parts?wo=${encodeURIComponent(t.workOrderNumber)}&part=${encodeURIComponent(partId)}`
  if (t.workOrderNumber) return `/parts?wo=${encodeURIComponent(t.workOrderNumber)}`
  return null
}

/** 工作台卡片流（pages/index.vue 拆分）：待办 + 提醒转成卡片排序、统计卡计数、?f= 筛选、按截止日分组。 */
export function useWorkbenchFeed(options: { todos: Ref<WorkbenchTodo[]>; reminders: Ref<RemindersData | null | undefined> }) {
  const { todos, reminders: data } = options
  const route = useRoute()

  const allCards = computed<Card[]>(() => {
    const list: Card[] = []
    for (const t of todos.value) {
      const bucket = (t.bucket ?? 'NO_DUE') as WorkBucket
      list.push({
        key: `t:${t.id}`,
        kind: 'todo',
        bucket,
        tone: bucket === 'OVERDUE' ? 'late' : 'normal',
        title: t.title,
        wo: t.workOrderNumber ?? null,
        dueDay: t.dueDay ?? null,
        createdAt: String(t.createdAt),
        unread: false,
        todo: t,
      })
    }
    for (const r of data.value?.items ?? []) {
      list.push({
        key: `r:${r.id}`,
        kind: 'reminder',
        bucket: r.bucket ?? 'NO_DUE',
        tone: r.cleared ? 'normal' : r.level === 'RED' ? 'late' : r.level === 'YELLOW' ? 'risk' : 'normal',
        title: r.title,
        wo: r.workOrderNumber ?? null,
        dueDay: r.dueDay ?? null,
        createdAt: r.createdAt,
        unread: !r.readAt,
        reminder: r,
      })
    }
    // 组内：红 → 黄 → 普通；同色未读在前，再按截止日从近到远（没有截止日的在后），待办在提醒前
    return list.sort(
      (a, b) =>
        TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
        Number(b.unread) - Number(a.unread) ||
        (a.dueDay ?? '9999').localeCompare(b.dueDay ?? '9999') ||
        (a.kind === b.kind ? 0 : a.kind === 'todo' ? -1 : 1),
    )
  })

  const active = computed<WorkbenchFilter | null>(() => ((WORKBENCH_FILTERS as readonly string[]).includes(route.query.f as string) ? (route.query.f as WorkbenchFilter) : null))
  const counts = computed(() => ({
    todo: todos.value.length,
    overdue: allCards.value.filter((c) => c.bucket === 'OVERDUE').length,
    today: allCards.value.filter((c) => c.bucket === 'TODAY').length,
    unread: data.value?.unread ?? 0,
  }))
  const statDenom = computed(() => Math.max(1, allCards.value.length))
  const cards = computed(() => {
    const f = active.value
    if (!f) return allCards.value
    if (f === 'todo') return allCards.value.filter((c) => c.kind === 'todo')
    if (f === 'overdue') return allCards.value.filter((c) => c.bucket === 'OVERDUE')
    if (f === 'today') return allCards.value.filter((c) => c.bucket === 'TODAY')
    return allCards.value.filter((c) => c.unread)
  })
  const groups = computed(() => groupByBucket(cards.value))
  /** 点统计卡：套用筛选；再点同一张取消 */
  const filterTo = (f: WorkbenchFilter) => ({ query: { ...route.query, f: active.value === f ? undefined : f } })

  return { allCards, active, counts, statDenom, cards, groups, filterTo }
}
