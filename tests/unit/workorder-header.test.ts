// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { loadComponent } from '../helpers/vue-component'

afterEach(() => vi.unstubAllGlobals())

it('keeps shared header navigation and completion when optional slots are absent', () => {
  vi.stubGlobal('computed', computed)
  const header = mount(loadComponent('app/components/ui/WoGroupHead.vue'), {
    props: { no: 'REAL-WO', done: 1, total: 2, count: 2, label: '设计完成' },
    global: {
      components: { WoLink: loadComponent('app/components/WoLink.vue') },
      stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
    },
  })
  try {
    expect(header.get('a').attributes('href')).toBe('/wo/REAL-WO')
    expect(header.text()).toContain('设计完成 1/2')
  } finally { header.unmount() }
})
