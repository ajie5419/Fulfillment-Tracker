// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import * as Vue from 'vue'
import * as rules from '../../shared/alert-rules'
import * as workbench from '../../shared/workbench'
import * as issues from '../../shared/issues'
import { loadComponent } from '../helpers/vue-component'

const cleanups: (() => void)[] = []
const dictionaries = { ...issues, RULE_TEXT: rules.RULE_TEXT, LEVEL_TEXT: rules.ALERT_LEVEL_TEXT, LEVEL_ORDER: ['RED', 'YELLOW', 'REMIND'], ISSUE_STATUS_COLOR: {} }
const alert = { id: 'alert', rule: 'W7', status: 'ACTIVE', level: 'YELLOW', subject: 'Assigned design', summary: '', owners: [], deptNames: [], firstAt: '2026-11-17', levelAt: '2026-11-17', canHandle: false, canConvert: false, link: '/drawings' }
function request(data: unknown) {
  return { data: Vue.ref(data), error: Vue.ref<Error | null>(null), pending: Vue.ref(false), refresh: vi.fn() }
}
let alerts: ReturnType<typeof request>
let issueRows: ReturnType<typeof request>
let funnelRows: ReturnType<typeof request>
const queries = new Map<string, Vue.ComputedRef<Record<string, unknown>>>()
let routeQuery: Record<string, string> = {}
beforeEach(() => {
  routeQuery = Vue.reactive({})
  queries.clear()
  alerts = request([alert])
  issueRows = request([])
  funnelRows = request([])
  for (const name of ['ref', 'computed', 'reactive', 'watch'] as const) vi.stubGlobal(name, Vue[name])
  for (const [key, value] of Object.entries(dictionaries)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRoute', () => ({ query: routeQuery }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useWorkOrders', async () => request([]))
  vi.stubGlobal('useApiFetch', async (url: string, options: { key?: string; query: Vue.ComputedRef<Record<string, unknown>> }) => {
    const key = options.key ?? url
    queries.set(key, options.query)
    return key === 'risk-issue-funnel' ? funnelRows : url === '/api/alerts' ? alerts : issueRows
  })
  vi.stubGlobal('dayText', (value: string | null) => value ?? '')
})
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })

async function render() {
  const component = loadComponent('app/pages/risks.vue', { '#shared/alert-rules': rules, '#shared/workbench': workbench })
  const container = Vue.defineComponent({ props: ['title'], setup: (props, { slots }) => () => Vue.h('div', [props.title, slots.title?.(), slots.default?.(), slots.extra?.()]) })
  const tableStub = Vue.defineComponent({
    props: ['columns', 'dataSource'],
    setup: (props, { slots }) => () => Vue.h('div', { class: 'table-stub' },
      (props.dataSource as Record<string, unknown>[]).map(record =>
        Vue.h('div', { class: 'rrow' }, (props.columns as { key: string }[]).map(column => slots.bodyCell?.({ column, record }))),
      )),
  })
  const button = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) })
  const link = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('a', slots.default?.()) })
  const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }) }), {
    global: {
      plugins: [(app: Vue.App) => Object.assign(app.config.globalProperties, dictionaries, { dayText: (value: string | null) => value ?? '' })],
      stubs: {
        UiPageHero: container, UiSectionCard: container, ASpin: container, AResult: container, AButton: button, NuxtLink: link,
        AEmpty: true, ASegmented: true, ASelect: true, ACheckbox: true, ATable: tableStub, ATag: true, UiHelpTip: true, UiRefreshButton: true,
        UiStatCard: true, UiFilterButton: true, UiFilterChips: true, UiStatusIcon: true, WoLink: true, IssueDrawer: true, IssueReportModal: true,
      },
    },
  })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  return wrapper
}

it('renders funnel KPI cards on default issues tab and alert action links on alerts tab', async () => {
  const issuesWrapper = await render()
  expect(issuesWrapper.find('.kpi-row').exists()).toBe(true)
  expect(issuesWrapper.findAll('ui-stat-card-stub')).toHaveLength(4)

  routeQuery = { tab: 'alerts' }
  const alertsWrapper = await render()
  expect(alertsWrapper.find('.go').text()).toBe('查看详情')
  alerts.data.value = [{ ...alert, canHandle: true }]
  await flushPromises()
  expect(alertsWrapper.find('.go').text()).toBe('去处理')
})

it('does not present a failed request as empty data and retries both sources', async () => {
  routeQuery = { tab: 'alerts' }
  alerts.error.value = new Error('offline')
  alerts.data.value = []
  alerts.refresh.mockImplementation(async () => { alerts.error.value = null; alerts.data.value = [alert] })
  const wrapper = await render()
  expect(wrapper.text()).toContain('预警数据加载失败')
  expect(wrapper.find('.empty-box').exists()).toBe(false)
  await wrapper.findAll('button').find(button => button.text() === '重试')!.trigger('click')
  await flushPromises()
  expect(alerts.refresh).toHaveBeenCalledTimes(1)
  expect(issueRows.refresh).toHaveBeenCalledTimes(1)
  expect(funnelRows.refresh).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).not.toContain('预警数据加载失败')
  expect(wrapper.findAll('.rrow')).toHaveLength(1)
})

it('counts the current work order independently of state filters and hides stale or failed counts', async () => {
  Object.assign(routeQuery, { tab: 'issues', wo: 'WO-A', status: 'OPEN' })
  funnelRows.data.value = [{ status: 'OPEN' }, { status: 'ACCEPTED' }]
  const wrapper = await render()
  const values = () => wrapper.findAll('ui-stat-card-stub').map(card => card.attributes('value'))
  expect(queries.get('/api/issues')?.value).toMatchObject({ status: 'OPEN', workOrderNumber: 'WO-A' })
  expect(queries.get('risk-issue-funnel')?.value).toMatchObject({ status: 'UNCLOSED', workOrderNumber: 'WO-A' })
  expect(values()).toEqual(['1', '1', '0', '0'])
  Object.assign(routeQuery, { wo: 'WO-B', status: 'RESOLVED', overdue: '1' })
  funnelRows.pending.value = true
  await flushPromises()
  expect(queries.get('risk-issue-funnel')?.value).toMatchObject({ status: 'UNCLOSED', workOrderNumber: 'WO-B' })
  expect(queries.get('risk-issue-funnel')?.value).not.toHaveProperty('overdue')
  expect(values()).toEqual(['—', '—', '—', '—'])
  funnelRows.pending.value = false
  funnelRows.error.value = new Error('offline')
  await flushPromises()
  expect(values()).toEqual(['—', '—', '—', '—'])
  funnelRows.error.value = null
  funnelRows.data.value = [{ status: 'RESOLVED' }]
  await flushPromises()
  expect(values()).toEqual(['0', '0', '0', '1'])
  routeQuery.tab = 'alerts'
  await flushPromises()
  expect(wrapper.find('.go').exists()).toBe(true)
  expect(queries.get('/api/issues')?.value).toMatchObject({ status: 'RESOLVED', workOrderNumber: 'WO-B', overdue: '1' })
})

it('shows the actual first occurrence when an alert has no elapsed-duration label', async () => {
  routeQuery.tab = 'alerts'
  const wrapper = await render()
  expect(wrapper.text()).toContain(`始于 ${workbench.factoryTimeText(alert.firstAt)}`)
  expect(wrapper.text()).not.toContain('刚触发')
})
