// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import * as Vue from 'vue'
import dayjs from 'dayjs'
import * as mobileTodo from '../../shared/mobile-todo'
import * as validation from '../../shared/plan-validation'
import { loadComponent } from '../helpers/vue-component'

afterEach(() => vi.unstubAllGlobals())

it('opens the real split dialog through a parent ref when the empty task list is hidden', async () => {
  for (const key of ['ref', 'computed', 'reactive'] as const) vi.stubGlobal(key, Vue[key])
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ users: [] }) }))
  const component = loadComponent('app/components/PlanNodeWork.vue', {
    dayjs, '#shared/mobile-todo': mobileTodo, '#shared/plan-validation': validation,
  })
  const child = Vue.ref<{ openSplit: () => void }>()
  const modal = Vue.defineComponent({
    props: ['open', 'title'],
    setup: (props) => () => props.open ? Vue.h('div', { role: 'dialog' }, props.title) : null,
  })
  const wrapper = mount({
    setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component, {
      ref: child, wo: 'WO', hideAddButton: true, canCreate: { drawing: true },
      node: { id: 'n', code: '2.2', name: '原材料采购计划', dept: 'TECH', canSplit: true, tasks: [], planDate: '2026-12-01' },
    }) }),
  }, { global: { stubs: { AModal: modal, DrawingEditModal: true, PurchaseEditModal: true, KittingNodeModal: true } } })
  await flushPromises()
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(child.value?.openSplit).toBeTypeOf('function')
  child.value!.openSplit()
  await Vue.nextTick()
  expect(wrapper.get('[role="dialog"]').text()).toContain('原材料采购计划')
  wrapper.unmount()
})
