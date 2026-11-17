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
beforeEach(() => {
  alerts = request([alert])
  issueRows = request([])
  for (const name of ['ref', 'computed', 'reactive', 'watch'] as const) vi.stubGlobal(name, Vue[name])
  for (const [key, value] of Object.entries(dictionaries)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useWorkOrders', async () => request([]))
  vi.stubGlobal('useApiFetch', async (url: string) => url === '/api/alerts' ? alerts : issueRows)
})
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })

async function render(me = { can: { overview: false }, deptHeadOf: [] as string[], pmOf: [] as string[] }) {
  vi.stubGlobal('useMe', async () => request(me))
  const component = loadComponent('app/pages/risks.vue', { '#shared/alert-rules': rules, '#shared/workbench': workbench })
  const container = Vue.defineComponent({ props: ['title'], setup: (props, { slots }) => () => Vue.h('div', [props.title, slots.default?.(), slots.extra?.()]) })
  const button = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) })
  const link = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('a', slots.default?.()) })
  const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }) }), {
    global: {
      plugins: [(app: Vue.App) => Object.assign(app.config.globalProperties, dictionaries)],
      stubs: {
        UiPageHero: container, UiSectionCard: container, ASpin: container, AResult: container, AButton: button, NuxtLink: link,
        AEmpty: true, ASegmented: true, ASelect: true, ACheckbox: true, UiHelpTip: true, UiRefreshButton: true, UiBarList: true,
        UiFilterButton: true, UiFilterChips: true, UiStatusIcon: true, WoLink: true, IssueDrawer: true, IssueReportModal: true,
      },
    },
  })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  return wrapper
}

it.each([
  [{ can: { overview: false }, deptHeadOf: [], pmOf: [] }, false],
  [{ can: { overview: false }, deptHeadOf: ['TECH'], pmOf: [] }, true],
  [{ can: { overview: false }, deptHeadOf: [], pmOf: ['WO'] }, true],
  [{ can: { overview: true }, deptHeadOf: [], pmOf: [] }, true],
])('renders management charts only for management scope: %j', async (me, charts) => {
  const wrapper = await render(me)
  expect(wrapper.find('.charts').exists()).toBe(charts)
  expect(wrapper.find('.go').text()).toBe('查看详情')
  alerts.data.value = [{ ...alert, canHandle: true }]
  await flushPromises()
  expect(wrapper.find('.go').text()).toBe('去处理')
})

it('does not present a failed request as empty data and retries both sources', async () => {
  alerts.error.value = new Error('offline')
  alerts.data.value = []
  alerts.refresh.mockImplementation(async () => { alerts.error.value = null; alerts.data.value = [alert] })
  const wrapper = await render({ can: { overview: true }, deptHeadOf: [], pmOf: [] })
  expect(wrapper.text()).toContain('风险数据加载失败')
  expect(wrapper.find('.charts').exists()).toBe(false)
  expect(wrapper.find('.empty-box').exists()).toBe(false)
  await wrapper.findAll('button').find(button => button.text() === '重试')!.trigger('click')
  await flushPromises()
  expect(alerts.refresh).toHaveBeenCalledTimes(1)
  expect(issueRows.refresh).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).not.toContain('风险数据加载失败')
  expect(wrapper.findAll('.rrow')).toHaveLength(1)
  expect(wrapper.find('.charts').exists()).toBe(true)
})
