import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref, watch, type EffectScope, type Ref } from 'vue'
import { useListLayout } from '../../app/composables/useListLayout'

let scope: EffectScope
let route: { query: Record<string, unknown> }
const cookies = new Map<string, Ref<unknown>>()
const replace = vi.fn()
const useCookie = vi.fn()

beforeEach(() => {
  scope = effectScope()
  route = reactive({ query: {} })
  cookies.clear()
  replace.mockReset().mockImplementation(({ query }: { query: Record<string, unknown> }) => {
    route.query = query
    return Promise.resolve()
  })
  useCookie.mockReset().mockImplementation((key: string) => {
    if (!cookies.has(key)) cookies.set(key, ref(undefined))
    return cookies.get(key)
  })
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useCookie', useCookie)
})
afterEach(() => { scope.stop(); vi.unstubAllGlobals() })

function create(defaultLayout: 'group' | 'board' | 'table' = 'board', preferenceKey?: string) {
  const layout = scope.run(() => useListLayout(defaultLayout, preferenceKey))
  if (!layout) throw new Error('Layout scope was not active')
  return layout
}
async function settle() {
  for (let i = 0; i < 4; i++) await nextTick()
}

it('prioritizes an explicit URL over the saved preference', () => {
  cookies.set('drawing-layout', ref('group'))
  route.query = { layout: 'table', wo: 'WO-1', view: 'done' }
  expect(create('board', 'drawing-layout').value).toBe('table')
})

it('remembers a selection for reopening without discarding unrelated filters', async () => {
  cookies.set('drawing-layout', ref('group'))
  route.query = { wo: 'WO-1', view: 'all', owner: 'owner-1' }
  const layout = create('board', 'drawing-layout')
  expect(layout.value).toBe('group')
  layout.value = 'table'
  await settle()
  expect(route.query).toMatchObject({ layout: 'table', wo: 'WO-1', view: 'all', owner: 'owner-1' })
  expect(cookies.get('drawing-layout')?.value).toBe('table')
  scope.stop()
  scope = effectScope()
  route.query = {}
  expect(create('board', 'drawing-layout').value).toBe('table')
})

it('follows a same-page URL change such as back navigation or a shared link', async () => {
  route.query = { layout: 'group', wo: 'WO-1' }
  const layout = create('board', 'drawing-layout')
  route.query = { layout: 'board', wo: 'WO-2', view: 'week' }
  await settle()
  expect(layout.value).toBe('board')
  expect(route.query).toMatchObject({ layout: 'board', wo: 'WO-2', view: 'week' })
})

it('falls back from invalid URL and saved values to a supported layout', () => {
  route.query = { layout: 'invalid' }
  cookies.set('drawing-layout', ref('table'))
  expect(create('board', 'drawing-layout').value).toBe('table')
  scope.stop()
  scope = effectScope()
  cookies.set('drawing-layout', ref('invalid'))
  expect(create('board', 'drawing-layout').value).toBe('board')
})

it('keeps callers without a preference key independent from the drawing preference', async () => {
  cookies.set('drawing-layout', ref('board'))
  const layout = create('group')
  expect(layout.value).toBe('group')
  expect(useCookie).not.toHaveBeenCalled()
  layout.value = 'table'
  await settle()
  expect(cookies.get('drawing-layout')?.value).toBe('board')
})
