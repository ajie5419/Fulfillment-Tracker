import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, shallowRef, toValue, watch, type EffectScope } from 'vue'
import { invalidatePagedList, usePagedList as originalUsePagedList } from '../../app/composables/usePagedList'

// Request binding is supplied by the domain; the adapter still owns only page state.
function usePagedList<T extends { id: string }>(url: string, options: Omit<Parameters<typeof originalUsePagedList<T>>[1], 'read'>) {
  return originalUsePagedList<T>(url, { ...options, read: (path, opts) => useRequestFetch()<import('../../shared/pagination').PageResult<T>, string>(path, opts) })
}

type Row = { id: string }
const reads: { query: Record<string, unknown>; resolve: (rows: Row[], total?: number, page?: number) => void; reject: () => void }[] = []
let scope: EffectScope
let activate: () => void
let deactivate: () => void

async function settle() { await nextTick(); await Promise.resolve(); await nextTick() }

beforeEach(() => {
  vi.stubGlobal('onActivated', (fn: () => void) => { activate = fn })
  vi.stubGlobal('onDeactivated', (fn: () => void) => { deactivate = fn })
  reads.length = 0
  scope = effectScope()
  const states = new Map()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  })
  vi.stubGlobal('useRequestFetch', () => (_url: string, { query }: { query: Record<string, unknown> }) => new Promise((resolve, reject) => {
    reads.push({ query, resolve: (rows, total = 100, page = query.page as number) => resolve({ rows, total, page, pageSize: query.pageSize }), reject: () => reject(new Error('offline')) })
  }))
  /** The Nuxt seam only supplies keyed request refs. Tests exercise our adapter's
   * accumulation and reset behavior, not Nuxt's request implementation. */
  vi.stubGlobal('useAsyncData', (key: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
    const data = shallowRef(), error = shallowRef(), status = ref('idle')
    let sequence = 0
    async function refresh() {
      const current = ++sequence
      status.value = 'pending'
      error.value = null
      try {
        const result = await handler(null, { signal: new AbortController().signal })
        if (current !== sequence) return
        data.value = result
        status.value = 'success'
      } catch (e) {
        if (current !== sequence) return
        error.value = e
        data.value = undefined
        status.value = 'error'
      }
    }
    watch(() => toValue(key as () => string), () => { void refresh() }, { immediate: true })
    return { data, error, status, refresh }
  })
})
afterEach(() => { scope.stop(); vi.unstubAllGlobals() })

describe('shared paged list adapter', () => {
  it('rebuilds loaded pages after inactive invalidation and continues at the aligned page', async () => {
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: { view: 'open', q: 'steel' }, mode: 'append', pageSize: ref(2) }))!
    reads[0]!.resolve([{ id: 'a' }, { id: 'b' }], 6); await settle()
    list.next(); await settle()
    reads[1]!.resolve([{ id: 'c' }, { id: 'd' }], 6); await settle()
    deactivate()
    invalidatePagedList('test'); await settle()
    expect(reads).toHaveLength(2)
    activate(); await settle()
    expect(reads[2]!.query).toEqual({ view: 'open', q: 'steel', page: 1, pageSize: 2 })
    reads[2]!.resolve([{ id: 'b' }, { id: 'c' }], 5); await settle()
    expect(list.rows.value).toEqual([])
    expect(list.pending.value).toBe(true)
    reads[3]!.resolve([{ id: 'd' }, { id: 'e' }], 5); await settle()
    expect(list.rows.value.map(r => r.id)).toEqual(['b', 'c', 'd', 'e'])
    expect(list.total.value).toBe(5)
    list.next(); await settle()
    expect(reads[4]!.query.page).toBe(3)
    reads[4]!.resolve([{ id: 'f' }], 5); await settle()
    expect(list.finished.value).toBe(true)
  })

  it('hides stale rows on reconciliation failure and retries the retained pages', async () => {
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, mode: 'append', pageSize: ref(1) }))!
    reads[0]!.resolve([{ id: 'a' }], 3); await settle()
    list.next(); await settle()
    reads[1]!.resolve([{ id: 'b' }], 3); await settle()
    invalidatePagedList('test'); await settle()
    reads[2]!.resolve([{ id: 'b' }], 2); await settle()
    reads[3]!.reject(); await settle()
    expect(list.rows.value).toEqual([])
    expect(list.total.value).toBe(3)
    expect(list.error.value).toBeTruthy()
    void list.next(); await settle()
    reads[4]!.resolve([{ id: 'b' }], 1); await settle()
    expect(list.rows.value).toEqual([{ id: 'b' }])
    expect(list.total.value).toBe(1)
    expect(list.page.value).toBe(1)
    expect(list.finished.value).toBe(true)
  })

  it('refreshes when returning even without a local mutation', async () => {
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, mode: 'append', pageSize: ref(2) }))!
    reads[0]!.resolve([{ id: 'old' }], 1); await settle()
    deactivate()
    activate(); await settle()
    expect(list.rows.value).toEqual([])
    expect(list.pending.value).toBe(true)
    reads[1]!.resolve([{ id: 'fresh' }], 1); await settle()
    expect(list.rows.value).toEqual([{ id: 'fresh' }])
  })

  it('accepts a clamped page while rebuilding a shrinking collection', async () => {
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, mode: 'append', pageSize: ref(1) }))!
    reads[0]!.resolve([{ id: 'a' }], 3); await settle()
    list.next(); await settle()
    reads[1]!.resolve([{ id: 'b' }], 3); await settle()
    invalidatePagedList('test'); await settle()
    reads[2]!.resolve([{ id: 'b' }], 2); await settle()
    reads[3]!.resolve([{ id: 'c' }], 1, 1); await settle()
    expect(list.rows.value).toEqual([{ id: 'c' }])
    expect(list.total.value).toBe(1)
    expect(list.page.value).toBe(1)
    expect(list.finished.value).toBe(true)
    await settle()
    expect(reads[4]!.query.page).toBe(1)
    reads[4]!.resolve([{ id: 'c' }], 1); await settle()
    expect(list.rows.value).toEqual([{ id: 'c' }])
  })

  it('retains successful rows on next-page failure and retries the same page', async () => {
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, mode: 'append', pageSize: ref(20) }))!
    reads[0]!.resolve([{ id: 'first' }]); await settle()
    list.next(); await settle()
    reads[1]!.reject(); await settle()
    expect(list.rows.value).toEqual([{ id: 'first' }])
    expect(list.finished.value).toBe(false)
    void list.next(); await settle()
    expect(reads[2]!.query.page).toBe(2)
    reads[2]!.resolve([{ id: 'second' }], 40); await settle()
    expect(list.rows.value.map((r) => r.id)).toEqual(['first', 'second'])
    expect(list.finished.value).toBe(true)
  })

  it('clears a previous filter and ignores its late response', async () => {
    const q = ref('old')
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: computed(() => ({ q: q.value })), mode: 'append' }))!
    reads[0]!.resolve([{ id: 'old-first' }]); await settle()
    list.next(); await settle()
    q.value = 'new'; await settle()
    expect(list.page.value).toBe(1)
    expect(list.rows.value).toEqual([])
    reads[1]!.resolve([{ id: 'old-second' }]); await settle()
    expect(list.rows.value).toEqual([])
    reads[2]!.resolve([{ id: 'new-first' }]); await settle()
    expect(list.rows.value).toEqual([{ id: 'new-first' }])
  })

  it('deduplicates IDs and prevents double loading while pending', async () => {
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, mode: 'append' }))!
    reads[0]!.resolve([{ id: 'shared' }]); await settle()
    list.next(); await settle(); list.next(); await settle()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve([{ id: 'shared' }, { id: 'new' }]); await settle()
    expect(list.rows.value.map((r) => r.id)).toEqual(['shared', 'new'])
  })

  it('uses replacement mode without accumulating previous pages', async () => {
    const page = ref(1)
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, page }))!
    reads[0]!.resolve([{ id: 'first' }]); await settle()
    page.value = 2; await settle()
    reads[1]!.resolve([{ id: 'second' }]); await settle()
    expect(list.rows.value).toEqual([{ id: 'second' }])
  })

  it('clears appended options when a dialog closes and does not fetch while disabled', async () => {
    const enabled = ref(true)
    const list = scope.run(() => usePagedList<Row>('/api/list', { key: 'test', query: {}, mode: 'append', enabled }))!
    reads[0]!.resolve([{ id: 'first' }]); await settle()
    enabled.value = false; await settle()
    expect(list.rows.value).toEqual([])
    expect(reads).toHaveLength(1)
    enabled.value = true; await settle()
    expect(reads[1]!.query.page).toBe(1)
  })
})
