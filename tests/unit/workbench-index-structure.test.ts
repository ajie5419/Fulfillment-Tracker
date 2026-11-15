// @vitest-environment jsdom
import * as Vue from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { loadComponent } from '../helpers/vue-component'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as alertRules from '../../shared/alert-rules'
import * as workbench from '../../shared/workbench'
import { flushVue, mountScript } from '../helpers/vue-script'

/**
 * 工作台首页（pages/index.vue）结构拆分特征化测试：编译真实 SFC 的 script，固定待办 / 提醒 / 路由输入，
 * 断言卡片流转换、过滤统计、概览文案、跳转与各类弹窗动作的请求顺序。拆分前后同一份断言必须通过。
 */
const composableModules = import.meta.glob('../../app/composables/useWorkbench*.ts', { eager: true }) as Record<string, Record<string, unknown>>

const todo = (over: Record<string, unknown>) => ({
  id: 't', title: '待办', workOrderNumber: null, dueDay: null, bucket: null, createdAt: '2026-11-01T01:00:00.000Z', action: null, step: null,
  planTask: null, plan: null, release: null, link: null, refType: null, refId: null, suggestion: null, ...over,
})
const TODOS = [
  todo({ id: 't1', title: '开工零件A', workOrderNumber: 'WO1', dueDay: '2026-11-03', bucket: 'OVERDUE', action: 'ARRANGE_START', step: { id: 's1', partId: 'p1', partName: '支腿', processName: '下料', supplierId: 'sup1', status: 'PENDING', mode: 'INTERNAL', held: false } }),
  todo({ id: 't2', title: '无截止日待办', refType: 'part', refId: 'p9', workOrderNumber: 'WO2' }),
  todo({ id: 't3', title: '今天到期', bucket: 'TODAY', dueDay: '2026-11-01', action: 'DO_PLAN_TASK', planTask: { id: 'pt1', name: '出图', nodeName: '图纸', link: '/plan?wo=WO3&node=n1' } }),
]
const REMINDERS = {
  unread: 2,
  digest: { id: 'd1', title: '每日汇总', level: 'YELLOW', readAt: null, createdAt: '2026-11-01T00:00:00.000Z', lines: ['a'] },
  pinned: [{ id: 'pin1', title: '同步失败', level: 'RED', readAt: null, createdAt: '2026-11-01T00:00:00.000Z', lines: ['x'], link: '/settings?tab=sync' }],
  items: [
    { id: 'r1', title: '红色预警', level: 'RED', readAt: null, createdAt: '2026-11-01T02:00:00.000Z', cleared: false, link: '/parts?wo=WO1', bucket: 'OVERDUE', dueDay: '2026-11-02', workOrderNumber: 'WO1', rule: 'W1' },
    { id: 'r2', title: '黄色预警', level: 'YELLOW', readAt: null, createdAt: '2026-11-01T03:00:00.000Z', cleared: false, link: null, bucket: 'TODAY', dueDay: '2026-11-01' },
    { id: 'r3', title: '已读已消除', level: 'RED', readAt: '2026-11-01T04:00:00.000Z', cleared: true, link: '/x', bucket: 'LATER', dueDay: '2026-12-01' },
    { id: 'r4', title: '提醒无日期', level: 'REMIND', readAt: '2026-11-01T04:00:00.000Z', cleared: false, link: null },
  ],
}

let calls: { url: string; method: string; body: unknown }[]
let toasts: [string, string][]
let modals: Record<string, any>[]
let route: { query: Record<string, string | undefined> }
let nav: string[]
let reminderCalls: string[]
let refreshTodos: ReturnType<typeof vi.fn>
let failUrl: string | null
let state: { reminders: any; todos: any[]; remindersError: unknown; todosError: unknown; pending: boolean }

beforeEach(() => {
  calls = []; toasts = []; modals = []; nav = []; reminderCalls = []; failUrl = null
  state = { reminders: structuredClone(REMINDERS), todos: structuredClone(TODOS), remindersError: null, todosError: null, pending: false }
  route = Vue.reactive({ query: {} as Record<string, string | undefined> })
  refreshTodos = vi.fn(async () => { reminderCalls.push('refreshTodos') })
  for (const name of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'nextTick'] as const) vi.stubGlobal(name, Vue[name])
  for (const mod of Object.values(composableModules)) for (const [key, value] of Object.entries(mod)) if (/^use[A-Z]/.test(key)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useReminders', async () => ({ data: Vue.ref(state.reminders), pending: Vue.ref(state.pending), error: Vue.ref(state.remindersError) }))
  vi.stubGlobal('useTodos', async () => ({ data: Vue.ref(state.todos), pending: Vue.ref(false), error: Vue.ref(state.todosError), refresh: refreshTodos }))
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ users: [{ id: 'u1', name: '甲', department: '设计' }, { id: 'u2', name: '乙', department: '采购' }] }) }))
  vi.stubGlobal('useMe', async () => ({ data: Vue.ref({ id: 'u1', name: '甲' }) }))
  vi.stubGlobal('refreshReminders', async () => { reminderCalls.push('refreshReminders') })
  vi.stubGlobal('readReminder', async (item: { id: string }) => { reminderCalls.push(`readReminder:${item.id}`) })
  vi.stubGlobal('readDigest', async (item: { id: string }) => { reminderCalls.push(`readDigest:${item.id}`) })
  vi.stubGlobal('readAllReminders', async () => { reminderCalls.push('readAll'); if (failUrl === 'readAll') throw new Error('boom') })
  vi.stubGlobal('navigateTo', async (to: string) => { nav.push(to) })
  vi.stubGlobal('apiError', (e: unknown) => (e instanceof Error ? e.message : String(e)))
  vi.stubGlobal('message', Object.fromEntries(['success', 'error', 'warning'].map((k) => [k, (text: string) => toasts.push([k, text])])))
  vi.stubGlobal('Modal', { confirm: (opts: Record<string, any>) => modals.push(opts) })
  vi.stubGlobal('apiFetch', async (url: string, opts: { method?: string; body?: unknown } = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body })
    if (failUrl === url) throw new Error('boom')
    if (url === '/api/parts/p1') return { quantity: 10, steps: [{ id: 's1', returnedQty: 4 }] }
    return {}
  })
})
afterEach(() => vi.unstubAllGlobals())

const feedModule = Object.entries(composableModules).find(([path]) => path.endsWith('useWorkbenchFeed.ts'))?.[1]
// 拆分前页面没有对 composable 的 import；拆分后页面显式 import 子模块，这里提供真实模块
const open = () => mountScript('app/pages/index.vue', {}, { '#shared/alert-rules': alertRules, '#shared/workbench': workbench, ...(feedModule ? { '../composables/useWorkbenchFeed': feedModule } : {}) })

async function openDom() {
  const component = loadComponent('app/pages/index.vue', { '#shared/alert-rules': alertRules, '#shared/workbench': workbench, '../composables/useWorkbenchFeed': feedModule })
  const box = Vue.defineComponent({
    props: ['title', 'subTitle', 'description', 'message'],
    setup: (p, { slots }) => () => Vue.h('div', [p.title, p.subTitle, p.description, p.message, ...Object.values(slots).map(s => s?.())]),
  })
  const segment = Vue.defineComponent({
    props: ['options', 'value'], emits: ['change'],
    setup: (p, { emit }) => () => Vue.h('nav', p.options.map((o: { value: string; label: string }) => Vue.h('button', { onClick: () => emit('change', o.value) }, o.label))),
  })
  const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }) }), {
    global: { plugins: [(app: Vue.App) => Object.assign(app.config.globalProperties, {
      navigateTo: (to: string) => { nav.push(to) },
      apiError: (e: Error) => e.message,
      readReminder: (r: { id: string }) => reminderCalls.push(`readReminder:${r.id}`),
      refreshReminders: () => reminderCalls.push('refreshReminders'),
    })], stubs: {
      ...Object.fromEntries(['UiPageHero', 'UiSectionCard', 'UiListItem', 'ASpin', 'AResult', 'AEmpty', 'AAlert'].map(k => [k, box])),
      ...Object.fromEntries(['UiFilterChips', 'UiRefreshButton', 'UiAlertMark', 'WoLink', 'NuxtLink', 'ASelect', 'ADropdown', 'AModal', 'SendStepModal', 'FinishStepModal', 'ReleaseDrawer'].map(k => [k, true])),
      ASegmented: segment,
      AButton: Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) }),
    } },
  })
  await flushPromises()
  return wrapper
}

describe('workbench rendered states', () => {
  it('puts actionable tasks first; notifications and collapsed digest appear only in their view', async () => {
    const wrapper = await openDom()
    expect(wrapper.text()).toContain('开工零件A')
    expect(wrapper.text()).not.toContain('每日汇总')
    expect(wrapper.text()).not.toContain('全部标为已读')
    expect(wrapper.text()).not.toContain('红色预警')
    const tab = wrapper.findAll('button').find(b => b.text().startsWith('通知 ·'))!
    await tab.trigger('click')
    expect(nav.at(-1)).toEqual({ query: { f: 'notifications', n: undefined } })
    route.query.f = 'notifications'
    await flushPromises()
    expect(wrapper.text()).not.toContain('开工零件A')
    expect(wrapper.text()).toContain('红色预警')
    expect(wrapper.text()).not.toContain('已读已消除')
    expect(wrapper.find('.summary-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.daily-summary ol').exists()).toBe(false)
    await wrapper.find('.summary-toggle').trigger('click')
    expect(wrapper.find('.daily-summary ol').text()).toBe('a')
    expect(reminderCalls).toContain('readDigest:d1')
    expect(calls).toEqual([])
    wrapper.unmount()
  })

  it('never renders a task failure as zero or empty; notification failure leaves working tasks accessible', async () => {
    state.todos = []; state.todosError = new Error('offline')
    let wrapper = await openDom()
    expect(wrapper.text()).toContain('待办加载失败')
    expect(wrapper.text()).toContain('待处理 —')
    expect(wrapper.text()).not.toContain('暂无待处理事项')
    await wrapper.findAll('button').find(b => b.text() === '重试')!.trigger('click')
    expect(refreshTodos).toHaveBeenCalled()
    wrapper.unmount()
    state.todos = structuredClone(TODOS); state.todosError = null; state.remindersError = new Error('offline')
    wrapper = await openDom()
    expect(wrapper.text()).toContain('通知加载失败，待办仍可处理')
    expect(wrapper.text()).toContain('开工零件A')
    expect(wrapper.text()).toContain('通知 · — 未读')
    route.query.f = 'notifications'
    await flushPromises()
    expect(wrapper.text()).toContain('通知加载失败')
    expect(wrapper.text()).not.toContain('没有符合条件的通知')
    wrapper.unmount()
  })
})

describe('工作台卡片流', () => {
  it('attaches only exact active object alerts; keeps converted, cleared and unrelated records accessible', async () => {
    state.todos[0].refType = 'step'; state.todos[0].refId = 's1'
    state.reminders.items[0].subject = { type: 'step', id: 's1' }
    state.reminders.items.push(
      { ...state.reminders.items[0], id: 'other-type', subject: { type: 'drawing', id: 's1' } },
      { ...state.reminders.items[0], id: 'other-order', workOrderNumber: 'WO9' },
      { ...state.reminders.items[0], id: 'converted', issueNo: 'I-001' },
      { ...state.reminders.items[0], id: 'cleared', cleared: true },
    )
    const v = await open()
    expect(v.state.cards.find((c: any) => c.todo?.id === 't1').alerts.map((r: any) => r.id)).toEqual(['r1'])
    expect(v.state.counts.overdue).toBe(1)
    route.query.f = 'notifications'
    await flushVue()
    expect(v.state.cards.map((c: any) => c.reminder.id)).toEqual(expect.arrayContaining(['other-type', 'other-order', 'converted']))
    expect(v.state.cards.map((c: any) => c.reminder.id)).not.toContain('r1')
    expect(v.state.cards.map((c: any) => c.reminder.id)).not.toContain('cleared')
    route.query.n = 'unread'
    await flushVue()
    expect(v.state.cards.map((c: any) => c.reminder.id)).toContain('r1')
    route.query.n = 'history'
    await flushVue()
    expect(v.state.cards.map((c: any) => c.reminder.id)).toContain('cleared')
    // Finishing or reassigning the task must not hide an unresolved alert.
    v.state.todos.splice(0, 1)
    route.query.n = 'attention'
    await flushVue()
    expect(v.state.cards.map((c: any) => c.reminder.id)).toContain('r1')
    v.unmount()
  })

  it('does not hide alerts behind a failed task request; scopes filters from the URL', async () => {
    state.todos[0].refType = 'step'; state.todos[0].refId = 's1'
    state.reminders.items[0].subject = { type: 'step', id: 's1' }
    state.todosError = new Error('offline')
    route.query.f = 'notifications'
    const v = await open()
    expect(v.state.cards.map((c: any) => c.key)).toContain('r:r1')
    expect(v.state.filterOptions[0].label).toBe('待处理 —')
    route.query.f = 'todo'; route.query.wo = 'WO2'
    await flushVue()
    expect(v.state.cards.map((c: any) => c.key)).toEqual(['t:t2'])
    route.query.wo = undefined; route.query.action = 'DO_PLAN_TASK'
    await flushVue()
    expect(v.state.cards.map((c: any) => c.key)).toEqual(['t:t3'])
    route.query.action = undefined
    await flushVue()
    expect(v.state.cards).toHaveLength(3)
    v.unmount()
  })

  it('待办 / 提醒合成卡片，按 红 → 黄 → 普通、未读在前、截止日近在前、待办在提醒前排序', async () => {
    const v = await open()
    expect(v.state.allCards.map((c: any) => [c.key, c.kind, c.bucket, c.tone, c.unread, c.dueDay, c.wo])).toEqual([
      ['r:r1', 'reminder', 'OVERDUE', 'late', true, '2026-11-02', 'WO1'],
      ['t:t1', 'todo', 'OVERDUE', 'late', false, '2026-11-03', 'WO1'],
      ['r:r2', 'reminder', 'TODAY', 'risk', true, '2026-11-01', null],
      ['t:t3', 'todo', 'TODAY', 'normal', false, '2026-11-01', null],
      ['r:r3', 'reminder', 'LATER', 'normal', false, '2026-12-01', null],
      ['t:t2', 'todo', 'NO_DUE', 'normal', false, null, 'WO2'],
      ['r:r4', 'reminder', 'NO_DUE', 'normal', false, null, null],
    ])
    expect(v.state.allCards[1].todo).toBe(v.state.todos[0])
    expect(v.state.allCards[0].reminder.id).toBe('r1')
    expect(v.state.allCards.map((c: any) => c.createdAt)[1]).toBe('2026-11-01T01:00:00.000Z')
    expect(v.state.counts).toEqual({ todo: 3, overdue: 1, today: 1, unread: 2 })
    expect(v.state.groups.map((g: any) => [g.bucket, g.items.map((c: any) => c.key)])).toEqual([
      ['OVERDUE', ['t:t1']], ['TODAY', ['t:t3']], ['NO_DUE', ['t:t2']],
    ])
    expect(v.state.toneIcon('late')).toBe('alert')
    expect(v.state.toneIcon('risk')).toBe('warn')
    expect(v.state.toneIcon('normal')).toBe('dot')
    v.unmount()
  })

  it.each([
    [undefined, 'todo', 3], ['todo', 'todo', 3], ['overdue', 'overdue', 1], ['today', 'today', 1], ['unread', 'unread', 2], ['bogus', 'todo', 3], ['notifications', 'notifications', 3],
  ])('?f=%s 过滤：active=%s，共 %i 条', async (f, active, total) => {
    route.query.f = f
    const v = await open()
    expect(v.state.active).toBe(active)
    expect(v.state.cards).toHaveLength(total)
    v.unmount()
  })

  it('switches views while preserving other query filters and reacts to route changes', async () => {
    route.query.x = '1'
    const v = await open()
    expect(v.state.filterTo('todo')).toEqual({ query: { x: '1', f: undefined, n: undefined } })
    route.query.f = 'todo'
    await flushVue()
    expect(v.state.filterTo('todo')).toEqual({ query: { x: '1', f: undefined } })
    expect(v.state.filterTo('unread')).toEqual({ query: { x: '1', f: 'unread' } })
    expect(v.state.cards.map((c: any) => c.key)).toEqual(['t:t1', 't:t3', 't:t2'])
    v.unmount()
  })

  it('待办加载态、清零与重试', async () => {
    let v = await open()
    expect(v.state.loadError).toBeNull()
    v.unmount()

    state.reminders = { items: [], unread: 0, digest: null, pinned: [] }; state.todos = []
    v = await open()
    expect(v.state.filterOptions[0].label).toBe('待处理 0')
    v.unmount()

    state.pending = true
    v = await open()
    expect(v.state.filterOptions[3].label).toContain('—')
    v.unmount()

    state.todosError = new Error('x')
    v = await open()
    expect(v.state.loadError).toBeInstanceOf(Error)
    await v.state.retryLoad()
    expect(reminderCalls).toEqual(['refreshTodos', 'refreshReminders'])
    v.unmount()
  })

  it('todoLink：优先级 link > plan > planTask > release > 工件 > 工单 > 无', async () => {
    const v = await open()
    const link = v.state.todoLink
    expect(link(todo({ link: '/a', plan: { link: '/b' } }))).toBe('/a')
    expect(link(todo({ plan: { link: '/b' }, planTask: { link: '/c' } }))).toBe('/b')
    expect(link(todo({ planTask: { link: '/c' } }))).toBe('/c')
    expect(link(todo({ release: { id: 'r 1' } }))).toBe('/releases?id=r%201')
    expect(link(todo({ workOrderNumber: 'W&1', step: { partId: 'p 1' } }))).toBe('/parts?wo=W%261&part=p%201')
    expect(link(todo({ workOrderNumber: 'W1', refType: 'part', refId: 'p2' }))).toBe('/parts?wo=W1&part=p2')
    expect(link(todo({ workOrderNumber: 'W1' }))).toBe('/parts?wo=W1')
    expect(link(todo({}))).toBeNull()
    v.unmount()
  })
})

describe('工作台提醒动作', () => {
  it('点卡片只对提醒生效：标已读并跳转；无链接只标已读', async () => {
    const v = await open()
    v.state.onCardClick(v.state.allCards.find((c: any) => c.key === 't:t1'))
    await flushVue()
    expect(reminderCalls).toEqual([])
    v.state.onCardClick(v.state.allCards.find((c: any) => c.key === 'r:r1'))
    await flushVue()
    v.state.onCardClick(v.state.allCards.find((c: any) => c.key === 'r:r2'))
    await flushVue()
    expect(reminderCalls).toEqual(['readReminder:r1', 'readReminder:r2'])
    expect(nav).toEqual(['/parts?wo=WO1'])
    v.unmount()
  })

  it('置顶故障先标已读再跳转；每日汇总切换展开并标已读；全部已读失败提示', async () => {
    const v = await open()
    await v.state.openPinned(REMINDERS.pinned[0])
    expect(reminderCalls).toEqual(['readDigest:pin1'])
    expect(nav).toEqual(['/settings?tab=sync'])
    expect(v.state.digestOpen).toBe(false)
    await v.state.openDigest()
    expect(v.state.digestOpen).toBe(true)
    expect(reminderCalls.at(-1)).toBe('readDigest:d1')
    await v.state.openDigest()
    expect(v.state.digestOpen).toBe(false)
    await v.state.readAll()
    expect(toasts).toEqual([])
    failUrl = 'readAll'
    await v.state.readAll()
    expect(toasts).toEqual([['error', 'boom']])
    v.unmount()
  })
})

describe('工作台待办动作', () => {
  const t = (i: number) => TODOS[i] as any

  it('登记发出：只有带工序的待办才打开弹窗', async () => {
    const v = await open()
    v.state.openSend(t(1))
    expect(v.state.sending).toBeNull()
    v.state.openSend(t(0))
    expect(v.state.sending).toEqual({ id: 's1', supplierId: 'sup1', title: '支腿 · 下料' })
    v.unmount()
  })

  it('开工：确认弹窗 → POST /api/steps/:id/start → 提示 → 刷新待办与提醒；失败只提示', async () => {
    const v = await open()
    v.state.start(t(1))
    expect(modals).toEqual([])
    v.state.start(t(0))
    expect(modals[0]).toMatchObject({ title: '确认开工：支腿 · 下料？', okText: '开工' })
    await modals[0]!.onOk()
    expect(calls).toEqual([{ url: '/api/steps/s1/start', method: 'POST', body: { source: 'PC' } }])
    expect(toasts).toEqual([['success', '已开工']])
    expect(reminderCalls).toEqual(['refreshTodos', 'refreshReminders'])
    failUrl = '/api/steps/s1/start'
    await modals[0]!.onOk()
    expect(toasts.at(-1)).toEqual(['error', 'boom'])
    expect(reminderCalls).toHaveLength(2)
    v.unmount()
  })

  it('完工：读取工件取数量与已回数量；失败提示', async () => {
    const v = await open()
    await v.state.finish(t(1))
    expect(calls).toEqual([])
    await v.state.finish(t(0))
    expect(calls).toEqual([{ url: '/api/parts/p1', method: 'GET', body: undefined }])
    expect(v.state.finishing).toEqual({ id: 's1', title: '支腿 · 下料', quantity: 10, doneQty: 4 })
    v.state.finishing = null
    failUrl = '/api/parts/p1'
    await v.state.finish(t(0))
    expect(v.state.finishing).toBeNull()
    expect(toasts).toEqual([['error', 'boom']])
    v.unmount()
  })

  it('完成部门任务：确认弹窗 → POST complete → 刷新', async () => {
    const v = await open()
    v.state.finishPlanTask(t(0))
    expect(modals).toEqual([])
    v.state.finishPlanTask(t(2))
    expect(modals[0]).toMatchObject({ title: '完成"出图"？', content: '总计划节点"图纸"下的任务，完成日记为今天。' })
    await modals[0]!.onOk()
    expect(calls).toEqual([{ url: '/api/plan/tasks/pt1/complete', method: 'POST', body: {} }])
    expect(toasts).toEqual([['success', '已完成']])
    expect(reminderCalls).toEqual(['refreshTodos', 'refreshReminders'])
    v.unmount()
  })

  it('转交：未选对象警告；成功后清空并刷新；失败保留弹窗状态', async () => {
    const v = await open()
    await v.state.transfer()
    expect(toasts).toEqual([['warning', '请选择转交对象']])
    v.state.transferring = t(2)
    await v.state.transfer()
    expect(toasts).toEqual([['warning', '请选择转交对象'], ['warning', '请选择转交对象']])
    v.state.transferTo = 'u2'
    failUrl = '/api/todos/t3/transfer'
    await v.state.transfer()
    expect(toasts.at(-1)).toEqual(['error', 'boom'])
    expect(v.state.transferring).toEqual(t(2))
    failUrl = null
    await v.state.transfer()
    expect(calls.at(-1)).toEqual({ url: '/api/todos/t3/transfer', method: 'POST', body: { toUserId: 'u2' } })
    expect(toasts.at(-1)).toEqual(['success', '已转交'])
    expect(v.state.transferring).toBeNull()
    expect(v.state.transferTo).toBeUndefined()
    expect(reminderCalls).toEqual(['refreshTodos', 'refreshReminders'])
    v.unmount()
  })

  it('afterTodo 并发刷新待办与提醒；releaseId 初始为空', async () => {
    const v = await open()
    expect(v.state.releaseId).toBeNull()
    await v.state.afterTodo()
    expect(reminderCalls).toEqual(['refreshTodos', 'refreshReminders'])
    v.unmount()
  })
})
