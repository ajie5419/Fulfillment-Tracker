// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import * as plan from '../../shared/plan'
import * as status from '../../shared/status'
import { loadComponent } from '../helpers/vue-component'

afterEach(() => vi.unstubAllGlobals())

it('真实节点层级只自动展开源头所在的分支，并显示原业务记录入口', () => {
  const parent = { id: 'purchase', seq: 2, name: '长周期物料', code: '2.1', phase: '采购', parentId: null, tasks: [] }
  const task = { id: 'p1', kind: 'purchase', name: '液压泵站', link: '/purchases?id=p1', statusText: '在途' }
  const nodes = [
    { ...parent, id: 'design', phase: '设计', name: '结构设计' }, parent,
    { ...parent, id: 'pump', seq: 3, parentId: parent.id, code: '2.1.1', name: '泵站到货', source: true, critical: true, selfDelayDays: 4, tasks: [task] },
  ]
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useApiFetch', () => ({ data: ref({ workOrder: {}, plan: { status: 'PUBLISHED' }, dateConflicts: [], nodes }), error: ref(null), refresh: vi.fn() }))
  const branch = loadComponent('app/components/BoardPlanBranch.vue', { '#shared/status': status })
  const component = loadComponent('app/components/BoardOrderPlan.vue', { '#shared/plan': plan })
  const wrapper = mount(component, { props: { wo: 'WO-1' }, global: {
    components: { BoardPlanBranch: branch },
    stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
  } })
  const opened = wrapper.findAll('details[open] > summary').map(s => s.text())
  expect(opened).toHaveLength(3)
  expect(opened).toEqual([expect.stringContaining('采购'), expect.stringContaining('长周期物料'), expect.stringContaining('泵站到货')])
  expect(wrapper.get('.reason').text()).toContain('泵站到货，自身晚 4 天')
  expect(wrapper.get('.task a').attributes('href')).toBe(task.link)
  wrapper.unmount()
})
