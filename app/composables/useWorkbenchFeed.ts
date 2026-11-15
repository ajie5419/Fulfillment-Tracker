import { computed, type Ref } from 'vue'
import { groupByBucket, type WorkBucket } from '#shared/workbench'
import { todoActionText } from '#shared/todo-actions'
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
  alerts: ReminderItem[]
}
const TONE_RANK: Record<Tone, number> = { late: 0, risk: 1, normal: 2 }

export const WORKBENCH_FILTERS = ['todo', 'overdue', 'today', 'notifications', 'unread'] as const
export type WorkbenchFilter = (typeof WORKBENCH_FILTERS)[number]
export const WORKBENCH_FILTER_TEXT: Record<WorkbenchFilter, string> = { todo: '待处理', overdue: '逾期', today: '今日到期', notifications: '通知', unread: '未读通知' }

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

/** Direct links already open details; avoid a second menu with the same destination. */
export function hasTodoMenu(t: WorkbenchTodo): boolean {
  return (t.refType !== 'drawing' && t.action !== 'SIGN_RELEASE' && t.action !== 'PURCHASE_PLAN_ISSUED')
    || (!!todoLink(t) && !t.link && !t.release && !t.plan)
}

/** Keep actionable tasks and notifications separate while preserving server-owned scopes and due dates. */
export function useWorkbenchFeed(options: { todos: Ref<WorkbenchTodo[]>; reminders: Ref<RemindersData | null | undefined>; todosAvailable?: Ref<boolean> }) {
  const { todos, reminders: data } = options
  const route = useRoute()

  const allCards = computed<Card[]>(() => {
    const list: Card[] = []
    const bySubject = new Map<string, Card>()
    for (const t of todos.value) {
      const bucket = (t.bucket ?? 'NO_DUE') as WorkBucket
      const card: Card = {
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
        alerts: [],
      }
      list.push(card)
      // Distinct actions stay actionable even when they share an object. Attach alerts once.
      if (t.refType && t.refId && !bySubject.has(`${t.refType}:${t.refId}`)) bySubject.set(`${t.refType}:${t.refId}`, card)
    }
    for (const r of data.value?.items ?? []) {
      const target = r.subject && !r.cleared && !r.issueNo && options.todosAvailable?.value !== false
        ? bySubject.get(`${r.subject.type}:${r.subject.id}`) : undefined
      if (target && (!r.workOrderNumber || !target.wo || r.workOrderNumber === target.wo)) {
        target.alerts.push(r)
        if (r.level === 'RED') target.tone = 'late'
        else if (r.level === 'YELLOW' && target.tone === 'normal') target.tone = 'risk'
      }
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
        alerts: [],
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

  const active = computed<WorkbenchFilter>(() => ((WORKBENCH_FILTERS as readonly string[]).includes(route.query.f as string) ? (route.query.f as WorkbenchFilter) : 'todo'))
  const isNotifications = computed(() => active.value === 'notifications' || active.value === 'unread')
  const notificationFilter = computed(() => active.value === 'unread' ? 'unread' : ['unread', 'history'].includes(String(route.query.n)) ? String(route.query.n) : 'attention')
  const selectedWo = computed(() => typeof route.query.wo === 'string' ? route.query.wo : undefined)
  const selectedAction = computed(() => typeof route.query.action === 'string' ? route.query.action : undefined)
  const counts = computed(() => ({
    todo: todos.value.length,
    overdue: todos.value.filter((t) => t.bucket === 'OVERDUE').length,
    today: todos.value.filter((t) => t.bucket === 'TODAY').length,
    unread: data.value?.unread ?? 0,
  }))
  const attachedIds = computed(() => new Set(allCards.value.flatMap(c => c.alerts.map(r => r.id))))
  const cards = computed(() => {
    const f = active.value
    return allCards.value.filter(c => {
      if (selectedWo.value && c.wo !== selectedWo.value) return false
      if (isNotifications.value) {
        if (!c.reminder) return false
        if (notificationFilter.value === 'unread') return c.unread
        if (notificationFilter.value === 'history') return true
        return !c.reminder.cleared && !attachedIds.value.has(c.reminder.id)
      }
      if (!c.todo || (selectedAction.value && c.todo.action !== selectedAction.value)) return false
      return f === 'todo' || (f === 'overdue' ? c.bucket === 'OVERDUE' : c.bucket === 'TODAY')
    })
  })
  const groups = computed(() => groupByBucket(cards.value))
  const workOrders = computed(() => [...new Set(allCards.value.map(c => c.wo).filter((wo): wo is string => !!wo))].sort().map(value => ({ value, label: value })))
  const actionOptions = computed(() => [...new Set(todos.value.map(t => t.action))].map(value => ({ value, label: todoActionText(value) })))
  /** Selecting a view preserves scope filters and supports browser back/forward. */
  const filterTo = (f: WorkbenchFilter) => ({ query: { ...route.query, f: f === 'todo' ? undefined : f, n: undefined } })
  const updateFilter = (key: 'wo' | 'action' | 'n', value?: string) => navigateTo({ query: { ...route.query, [key]: value || undefined, ...(key === 'n' ? { f: 'notifications' } : {}) } })

  return { allCards, active, counts, cards, groups, filterTo, isNotifications, notificationFilter, selectedWo, selectedAction, workOrders, actionOptions, updateFilter }
}
