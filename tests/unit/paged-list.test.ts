import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, shallowRef, toValue, watch, type EffectScope } from 'vue'
import { usePagedList } from '../../app/composables/usePagedList'

type Row = { id: string }
const reads: { query: Record<string, unknown>; resolve: (rows: Row[], total?: number) => void; reject: () => void }[] = []
let scope: EffectScope

async function settle() { await nextTick(); await Promise.resolve(); await nextTick() }

beforeEach(() => {
  reads.length = 0
  scope = effectScope()
  const states = new Map()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  })
  vi.stubGlobal('useRequestFetch', () => (_url: string, { query }: { query: Record<string, unknown> }) => new Promise((resolve, reject) => {
    reads.push({ query, resolve: (rows, total = 100) => resolve({ rows, total, page: query.page, pageSize: query.pageSize }), reject: () => reject(new Error('offline')) })
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
