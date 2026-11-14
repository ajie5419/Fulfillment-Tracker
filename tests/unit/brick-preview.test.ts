// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadComponent } from '../helpers/vue-component'

const pageMeta = vi.fn()
beforeEach(() => {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('definePageMeta', pageMeta)
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('SPOTLIGHT_MAX_ITEMS', 4)
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

vi.stubGlobal('SPOTLIGHT_MAX_ITEMS', 4)
const components = {
  UiSpotlightGrid: loadComponent('app/components/ui/SpotlightGrid.vue'),
  UiUserChip: loadComponent('app/components/ui/UserChip.vue'),
  UiAlertMark: loadComponent('app/components/ui/AlertMark.vue'),
  UiWoGroupHead: loadComponent('app/components/ui/WoGroupHead.vue'),
  WoLink: loadComponent('app/components/WoLink.vue'),
}
const global = {
  components,
  stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
}

it('renders anonymous sample data using shared components without linking fictional work orders', async () => {
  const fetcher = vi.fn(() => { throw new Error('The public preview must not request protected data') })
  vi.stubGlobal('useApiFetch', fetcher)
  const page = mount(loadComponent('app/pages/brick-demo.vue'), { global, attachTo: document.body })
  try {
    expect(pageMeta).toHaveBeenCalledWith({ layout: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(page.findAllComponents(components.UiSpotlightGrid)).toHaveLength(1)
    expect(page.findAllComponents(components.UiWoGroupHead)).toHaveLength(2)
    expect(page.findAllComponents(components.UiUserChip).length).toBeGreaterThan(2)
    expect(page.findAllComponents(components.UiAlertMark).length).toBeGreaterThan(0)
    expect(page.findAll('a').map(link => link.attributes('href'))).toEqual(['/plan'])
    expect(page.text()).toContain('已完成 2/4')
    await page.get('button[aria-label="收起 DEMO-001"]').trigger('click')
    expect(page.get('section[aria-label="DEMO-001 甘特图"]').isVisible()).toBe(false)
    await page.get('button[aria-label="展开 DEMO-001"]').trigger('click')
    const expanded = page.get('section[aria-label="DEMO-001 甘特图"]')
    expect(expanded.isVisible(), JSON.stringify(expanded.attributes())).toBe(true)
    await page.get('.sp-row').trigger('click')
    expect(page.get('[role="status"]').text()).toContain('原材料与型材采购')
  } finally { page.unmount() }
})

it('anchors every task state directly to the timeline with duration-based widths', () => {
  const page = mount(loadComponent('app/pages/brick-demo.vue'), { global })
  try {
    for (const [id, start, duration] of [['n1', 1, 2], ['n3', 2, 5], ['n4', 2, 3], ['n5', 2, 8], ['m3', 3, 6]] as const) {
      const bar = page.get(`[data-node="${id}"] .gantt-bar`).element as HTMLElement
      expect(bar.parentElement?.className).toBe('timeline-track')
      expect(parseFloat(bar.style.left)).toBeCloseTo(start / 15 * 100)
      expect(parseFloat(bar.style.width)).toBeCloseTo(duration / 15 * 100)
    }
  } finally { page.unmount() }
})

it('keeps the normal shared header links when preview-specific slots are absent', () => {
  const header = mount(components.UiWoGroupHead, { global, props: { no: 'REAL-WO', done: 1, total: 2, count: 2, label: '设计完成' } })
  expect(header.get('a').attributes('href')).toBe('/wo/REAL-WO')
  expect(header.text()).toContain('设计完成 1/2')
  header.unmount()
})

it('keeps preview colors under the shared palette', () => {
  const css = readFileSync('app/assets/brick-demo.css', 'utf8')
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
  expect(css).toContain('var(--ft-late-text)')
  expect(css).toContain('var(--ft-primary-bg)')
})
