// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import * as Vue from 'vue'
import * as panorama from '../../shared/panorama'
import { loadComponent } from '../helpers/vue-component'

const wrappers: { unmount: () => void }[] = []
beforeEach(() => {
  for (const name of ['ref', 'computed', 'watch'] as const) vi.stubGlobal(name, Vue[name])
  vi.stubGlobal('definePageMeta', vi.fn())
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const container = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
function render(component: Vue.Component, stubs = {}) {
  const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }) }), { global: { stubs } })
  wrappers.push(wrapper)
  return wrapper
}

describe('全景旧路由及手机总览导航', () => {
  it.each([false, true])('旧路由真实页面执行 replace 跳转而不漏参数 mobile=%s', async mobile => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(mobile ? 'iPhone Mobile' : 'Desktop')
    const route = { query: { manager: '', metric: 'abnormal', productLine: 'A / 中文', closed: '1' }, hash: '#list' }
    const navigate = vi.fn()
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('navigateTo', navigate)
    render(loadComponent('app/pages/panorama.vue', { '#shared/panorama': panorama }))
    await flushPromises()
    expect(navigate).toHaveBeenCalledWith({ path: mobile ? '/m/board' : '/board', query: { ...route.query, view: 'panorama' }, hash: '#list' }, { replace: true })
  })

  it('手机页签修改与浏览器回退跟随 URL，保留统计条件', async () => {
    const route = Vue.reactive({ query: { view: 'panorama', metric: 'abnormal', manager: '' } })
    const replace = vi.fn(async (location: any) => { Object.assign(route.query, location.query) })
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ replace }))
    const tabs = Vue.defineComponent({ props: ['active'], emits: ['update:active'], setup: (props, { emit, slots }) => () => Vue.h('div', [Vue.h('button', { onClick: () => emit('update:active', props.active === 'orders' ? 'panorama' : 'orders') }, '切换'), slots.default?.()]) })
    const content = Vue.defineComponent({ props: { mobile: Boolean, listOnly: Boolean }, setup: props => () => Vue.h('p', props.mobile && props.listOnly ? '手机工单清单' : '手机统计') })
    const wrapper = render(loadComponent('app/pages/m/board.vue'), { VanNavBar: container, VanTabs: tabs, VanTab: container, BoardPanorama: content })
    await flushPromises()
    expect(wrapper.text()).toContain('手机统计')
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(replace).toHaveBeenCalledWith({ query: { view: 'orders', metric: 'abnormal', manager: '' }, hash: '' })
    expect(wrapper.text()).toContain('手机工单清单')
    route.query.view = 'panorama'
    await Vue.nextTick()
    expect(wrapper.text()).toContain('手机统计')
  })

  it.each([false, true])('桌面页签可切统计，驾驶舱仍按权限展示 canOverview=%s', async canOverview => {
    const route = Vue.reactive({ query: { view: 'panorama', manager: '' }, hash: '' })
    const replace = vi.fn(async (location: any) => { Object.assign(route.query, location.query) })
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useMe', async () => ({ data: Vue.ref({ can: { overview: canOverview } }) }))
    vi.stubGlobal('navigateTo', vi.fn())
    vi.stubGlobal('useApiFetch', async (url: string) => ({ data: Vue.ref(url === '/api/work-orders' ? [] : { rows: [], summary: {}, sourceByDept: [], syncErrors: [], syncConfigured: false }), refresh: vi.fn(), pending: Vue.ref(false), error: Vue.ref(null) }))
    const segmented = Vue.defineComponent({ props: ['options'], emits: ['change'], setup: (props, { emit }) => () => Vue.h('div', props.options.map((option: any) => Vue.h('button', { onClick: () => emit('change', option.value) }, option.label))) })
    const component = loadComponent('app/pages/board.vue', { '#shared/status': await import('../../shared/status'), '#shared/board-cockpit': await import('../../shared/board-cockpit') })
    const wrapper = render(component, { ASegmented: segmented, BoardPanorama: Vue.defineComponent({ setup: () => () => Vue.h('p', '统计区域') }), BoardCockpit: Vue.defineComponent({ setup: () => () => Vue.h('p', '管理区域') }), UiRefreshButton: container, AButton: container, AResult: container, AEmpty: container, ASwitch: container, ASelect: container, UiStatCard: container, UiColumnChart: container, UiSectionCard: container, WorkOrderCreate: container, UiHelpTip: container })
    await flushPromises()
    expect(wrapper.text()).toContain('全盘统计')
    expect(wrapper.text()).toContain('统计区域')
    expect(wrapper.text().includes('今天盯什么')).toBe(canOverview)
    if (canOverview) {
      await wrapper.findAll('button').find(button => button.text() === '今天盯什么')!.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('管理区域')
    }
    await wrapper.findAll('button').find(button => button.text() === '全盘统计')!.trigger('click')
    await flushPromises()
    expect(route.query).toEqual({ view: 'panorama', manager: '' })
  })

  it('手机异常下钻、切页签、打开抽屉均保留工单和返回条件，scope 仍交由原接口', async () => {
    const route = Vue.reactive({ query: { tab: 'all', workOrderNumber: 'WO-01', returnTo: '/m/board?view=orders&metric=abnormal', id: undefined as string | undefined } })
    const replace = vi.fn(async (location: any) => { Object.assign(route.query, location.query) })
    let requestQuery: Vue.ComputedRef<any> | undefined
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useApiRequestFetch', () => vi.fn())
    vi.stubGlobal('useApiFetch', async (url: string, options: any) => {
      expect(url).toBe('/api/issues')
      requestQuery = options.query
      return { data: Vue.ref([]), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
    })
    vi.stubGlobal('useAsyncData', async () => ({ data: Vue.ref(null), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }))
    const tabs = Vue.defineComponent({ emits: ['update:active'], setup: (_, { emit, slots }) => () => Vue.h('div', [Vue.h('button', { onClick: () => emit('update:active', 'responsible') }, '我负责'), slots.default?.()]) })
    const wrapper = render(loadComponent('app/pages/m/issues.vue', { '#shared/mobile-todo': {} }), { VanNavBar: container, VanButton: container, VanTabs: tabs, VanTab: container, VanCell: container, VanEmpty: container, VanPopup: container, VanDialog: container, VanField: container })
    await flushPromises()
    expect(requestQuery!.value).toEqual({ mine: undefined, status: 'UNCLOSED', dept: '0', workOrderNumber: 'WO-01' })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(requestQuery!.value.mine).toBe('responsible')
    expect(replace).toHaveBeenLastCalledWith({ query: expect.objectContaining({ workOrderNumber: 'WO-01', returnTo: route.query.returnTo }) })
    route.query.workOrderNumber = 'WO-02'
    route.query.id = 'issue-2'
    await flushPromises()
    expect(requestQuery!.value.workOrderNumber).toBe('WO-02')
    expect(replace).toHaveBeenLastCalledWith({ query: expect.objectContaining({ workOrderNumber: 'WO-02', id: 'issue-2', returnTo: route.query.returnTo }) })
  })
})
