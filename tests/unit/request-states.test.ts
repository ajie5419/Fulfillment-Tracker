// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import * as Vue from 'vue'
import * as workbench from '../../shared/workbench'
import * as drawing from '../../shared/drawing'
import * as mobileTodo from '../../shared/mobile-todo'
import { useRequestState } from '../../app/composables/useRequestState'
import { loadComponent } from '../helpers/vue-component'

const cleanups: (() => void)[] = []
const requests = new Map<string, ReturnType<typeof request>>()
function request(data: unknown, failed = false) {
  const result = { data: Vue.ref(data), pending: Vue.ref(false), error: Vue.ref<unknown>(failed ? new Error('offline') : null), refresh: vi.fn() }
  result.refresh.mockImplementation(async () => { result.error.value = null })
  return result
}
beforeEach(() => {
  requests.clear()
  for (const name of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) vi.stubGlobal(name, Vue[name])
  vi.stubGlobal('useRequestState', useRequestState)
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useRequestFetch', () => vi.fn())
  vi.stubGlobal('useFetch', async (url: string) => requests.get(url))
  vi.stubGlobal('useAsyncData', async () => requests.get('/api/drawings'))
  vi.stubGlobal('useWorkOrders', async () => request([]))
  vi.stubGlobal('useMaster', async () => request({ users: [] }))
  vi.stubGlobal('useMe', async () => request(null))
  vi.stubGlobal('useListLayout', () => Vue.ref('group'))
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('canDo', () => false)
  vi.stubGlobal('dayAfter', () => '2026-11-01')
  vi.stubGlobal('apiError', (e: Error) => e.message)
  vi.stubGlobal('LAYOUT_OPTIONS', [])
  vi.stubGlobal('RELEASE_TYPE_TEXT', {})
})
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })

const container = Vue.defineComponent({
  props: ['title', 'subTitle', 'description', 'message'],
  setup: (props, { slots }) => () => Vue.h('div', [props.title, props.subTitle, props.message, props.description, slots.default?.(), slots.extra?.(), slots.action?.()]),
})
const button = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) })
const stat = Vue.defineComponent({ props: ['value'], setup: (props, { slots }) => () => Vue.h('div', { class: 'stat' }, [String(props.value ?? ''), slots.value?.(), slots.sub?.()]) })
async function page(file: string) {
  const component = loadComponent(file, { '#shared/workbench': workbench, '#shared/drawing': drawing, '#shared/mobile-todo': mobileTodo })
  const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }) }), {
    global: { plugins: [(app: Vue.App) => Object.assign(app.config.globalProperties, { apiError: (e: unknown) => e instanceof Error ? e.message : '', canDo: () => false, LAYOUT_OPTIONS: [] })], stubs: Object.fromEntries([
      ...['ACard', 'AResult', 'AAlert', 'ATabs', 'ATabPane', 'AEmpty', 'VanEmpty', 'VanTabs'].map(name => [name, container]),
      ['AButton', button], ['VanButton', button], ['UiStatCard', stat],
      ...['ASpin', 'VanLoading', 'ASelect', 'ASegmented', 'ACheckbox', 'ATable', 'UiHelpTip', 'UiRefreshButton', 'UiRing', 'VanTab', 'VanNavBar', 'DrawingEditModal', 'ReleaseCreateModal', 'ReleaseDrawer', 'KittingNodeModal', 'AModal', 'AInputSearch', 'ATag', 'ASpace', 'KittingNodeCard', 'KittingShortageTable', 'WoLink', 'PlanNodeCell', 'VanTag', 'MCard', 'UiStatusIcon', 'UiWoGroupHead', 'UiStatusTag', 'UiDatePicker', 'AFormItem', 'AForm', 'AProgress', 'NuxtLink', 'AMenuItem', 'AMenu', 'ADropdown'].map(name => [name, true]),
    ]) },
  })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  return wrapper
}

const cases = [
  ['releases.vue', '/api/releases', [], '还没有发放单'],
  ['kitting.vue', '/api/kitting', { rows: [], total: 0, stats: null }, '还没有装配节点'],
  ['m/releases.vue', '/api/receipts', [], '没有待签收的发放单'],
  ['m/drawings.vue', '/api/drawings', { rows: [], total: 0, stats: null }, '没有设计中的任务'],
  ['drawings.vue', '/api/drawings/load', { week: { monday: '', sunday: '' }, rows: [] }, '没有未完成的设计任务'],
] as const

it.each(cases)('%s：默认空值失败显示错误，点击重试调用原生 refresh', async (file, url, data, empty) => {
  requests.set('/api/releases/stats', request(null))
  requests.set('/api/drawings', request({ rows: [], total: 0, stats: null }))
  requests.set('/api/drawings/load', request({ week: { monday: '', sunday: '' }, rows: [] }))
  const failed = request(data, true)
  requests.set(url, failed)
  const wrapper = await page(`app/pages/${file}`)
  expect(wrapper.text()).toContain('offline')
  if (file !== 'drawings.vue') expect(wrapper.text()).not.toContain(empty)
  const retry = wrapper.findAll('button').find(b => b.text() === '重试')!
  await retry.trigger('click')
  expect(failed.refresh).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).not.toContain('offline')
})

it('发放统计失败时隐藏旧数字并提供独立重试', async () => {
  requests.set('/api/releases', request([]))
  const stats = request({ all: 23, pending: 12, rejected: 3, minePending: 8 }, true)
  requests.set('/api/releases/stats', stats)
  const wrapper = await page('app/pages/releases.vue')
  expect(wrapper.findAll('.stat').map(s => s.text())).toEqual(['—', '—', '—', '—'])
  await wrapper.findAll('button').find(b => b.text() === '重试')!.trigger('click')
  expect(stats.refresh).toHaveBeenCalledTimes(1)
  expect(wrapper.findAll('.stat')[0]!.text()).toBe('23')
})

it('四态跟随原生请求结果，失败和加载中的统计使用占位符，成功的 0 保留', () => {
  const pending = Vue.ref(true), error = Vue.ref<unknown>(null), rows = Vue.ref<unknown[]>([])
  const { state, displayStat } = useRequestState({ pending, error }, () => !rows.value.length)
  expect(state.value).toBe('loading')
  expect(displayStat(0)).toBe('—')
  pending.value = false
  error.value = new Error('offline')
  expect(state.value).toBe('error')
  expect(displayStat(0)).toBe('—')
  error.value = null
  expect(state.value).toBe('empty')
  rows.value = [{ id: 'loaded' }]
  expect(state.value).toBe('success')
  expect(displayStat(0)).toBe(0)
  expect(displayStat(null)).toBe('—')
})
