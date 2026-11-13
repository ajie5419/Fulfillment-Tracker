import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { mountScript } from '../helpers/vue-script'

afterEach(() => vi.unstubAllGlobals())

it('counts child completion alongside directly attached tasks without hiding unfinished work', async () => {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  const parent = { id: 'parent', parentId: null, done: false, childCount: 3, taskCount: 0, doneCount: 0 }
  const children = [true, true, false].map((done, i) => ({ id: `child-${i}`, parentId: parent.id, done }))
  const view = await mountScript('app/components/PlanGantt.vue', { nodes: [parent, ...children], today: '2026-11-13', deliveryDate: null })
  try {
    expect(view.state.nodeProgress(parent)).toBe(67)
    expect(view.state.nodeProgress({ ...parent, taskCount: 1 })).toBe(50)
    expect(view.state.nodeProgress({ ...parent, taskCount: 1, doneCount: 1 })).toBe(75)
    expect(view.state.nodeProgress({ ...parent, childCount: 4 })).toBe(50)
    expect(view.state.nodeProgress({ ...parent, done: true })).toBe(100)
    expect(view.state.nodeProgress({ id: 'leaf', done: false, taskCount: 4, doneCount: 1 })).toBe(25)
    expect(view.state.nodeProgress({ id: 'empty', done: false })).toBe(0)
  } finally {
    view.unmount()
  }
})
