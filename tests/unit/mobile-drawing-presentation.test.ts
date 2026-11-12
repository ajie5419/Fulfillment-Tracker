// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import * as Vue from 'vue'
import * as mobileTodo from '../../shared/mobile-todo'
import { drawingPresentation } from '../../shared/drawing'
import { DRAWING_STATUS_TYPE, type DrawingRow } from '../../app/composables/useDrawings'
import { useRequestState } from '../../app/composables/useRequestState'
import { loadComponent } from '../helpers/vue-component'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals() })

function task(confirmed: boolean): DrawingRow {
  const facts = {
    status: 'DRAWN' as const, planDate: '2026-11-09', drawnDate: '2026-11-10', released: false,
    needsCustomerConfirm: true, customerPlanDate: '2026-11-11', customerConfirmedDate: confirmed ? '2026-11-12' : null, alertLevel: null,
  }
  return {
    ...facts, id: 'drawing', workOrderNumber: 'WO-1', componentName: '车架', ownerId: 'designer', ownerName: '设计员', ownerText: '设计员',
    startDate: null, drawnBy: 'designer', drawnByName: '设计员', customerConfirmedBy: confirmed ? 'pm' : null,
    customerConfirmedByName: confirmed ? '项目经理' : null, customerConfirmationNote: confirmed ? '客户邮件确认' : null,
    statusText: '设计完成', materialStatus: 'NOT_STARTED', materialAt: null, materialBy: null,
    processStatus: 'NONE', processAt: null, processBy: null, processText: '料单未开始 · 工艺无', note: null,
    partIds: [], parts: [], planNodeId: null, planNode: null, overdue: !confirmed, releases: [],
    createdBy: 'designer', createdAt: '2026-11-01', updatedAt: '2026-11-12',
    presentation: drawingPresentation(facts, '2026-11-14'),
    permissions: { markDrawn: false, undoDrawn: true, confirm: !confirmed, release: true },
  }
}

const container = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
const tag = Vue.defineComponent({ props: ['type'], setup: (props, { slots }) => () => Vue.h('span', { 'data-tag-type': props.type }, slots.default?.()) })

it.each([
  [false, false], [false, true], [true, false], [true, true],
])('手机任务与提醒卡片共享确认日期和逾期语义：提醒=%s，已确认=%s', async (focused, confirmed) => {
  const row = task(confirmed)
  for (const name of ['ref', 'computed', 'watch', 'onMounted'] as const) vi.stubGlobal(name, Vue[name])
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useRoute', () => ({ query: focused ? { id: row.id } : {} }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useRequestState', useRequestState)
  vi.stubGlobal('fetchDrawing', async () => row)
  vi.stubGlobal('useApiFetch', async () => ({ data: Vue.ref({ rows: focused ? [] : [row], total: 1, stats: null }), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }))
  const component = loadComponent('app/pages/m/drawings.vue', { '#shared/mobile-todo': mobileTodo })
  const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }) }), {
    global: {
      plugins: [(app: Vue.App) => Object.assign(app.config.globalProperties, { DRAWING_STATUS_TYPE, dayText: (value: string) => value.slice(0, 10), partsText: (parts: string[]) => parts.join('、') })],
      stubs: { MCard: container, VanTag: tag, VanTabs: container, VanTab: true, VanNavBar: true, VanButton: true, VanLoading: true, VanEmpty: true },
    },
  })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  expect(wrapper.text()).toContain('设计完成 · 待发放')
  const designTag = wrapper.findAll('[data-tag-type]').find(node => node.text() === '设计完成 · 待发放')!
  expect(designTag.attributes('data-tag-type')).not.toBe('danger')
  expect(wrapper.text()).toContain(confirmed ? '已确认 · 11-12' : '客户确认逾期 3 天')
  expect(wrapper.text()).not.toContain('设计逾期')
  expect(wrapper.findAll('.m-text-late').map(node => node.text())).toEqual(confirmed ? [] : ['客户确认逾期 3 天'])
})
