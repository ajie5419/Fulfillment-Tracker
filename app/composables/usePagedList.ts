import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import type { PageResult } from '#shared/pagination'
import { DEFAULT_PAGE_SIZE } from '#shared/pagination'

export function invalidatePagedList(key: string) {
  useState<number>(`paged:${key}:revision`, () => 0).value++
}

/** Nuxt owns requests and SSR transfer. This adapter only joins successful pages
 * for one filter identity; it does not implement another request cache. */
export function usePagedList<T extends { id: string }, P extends PageResult<T> = PageResult<T>>(
  url: string,
  options: { key: string; query: MaybeRefOrGetter<Record<string, unknown>>; mode?: 'replace' | 'append'; page?: Ref<number>; pageSize?: Ref<number>; enabled?: MaybeRefOrGetter<boolean> },
) {
  const revision = useState<number>(`paged:${options.key}:revision`, () => 0)
  const reconciled = useState<number>(`paged:${options.key}:reconciled`, () => 0)
  const active = ref(true)
  const reconciling = ref(false)
  const reconcileError = shallowRef<unknown>(null)
  const dirty = computed(() => revision.value !== reconciled.value)
  const append = options.mode === 'append'
  const state = useState<{ scope: string; rows: T[]; page: number; pageSize: number; total: number; lastPage: number }>(
    `paged:${options.key}`, () => ({ scope: '', rows: [], page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, lastPage: 0 }),
  )
  const page = options.page ?? computed({ get: () => state.value.page, set: (v: number) => { state.value.page = v } })
  const pageSize = options.pageSize ?? computed({ get: () => state.value.pageSize, set: (v: number) => { state.value.pageSize = v } })
  const enabled = computed(() => options.enabled === undefined || toValue(options.enabled))
  const scope = computed(() => JSON.stringify([toValue(options.query), pageSize.value]))
  watch(enabled, (value) => {
    if (!value && append) {
      state.value.rows = []
      state.value.total = 0
      state.value.lastPage = 0
      page.value = 1
    }
  }, { immediate: true, flush: 'sync' })
  watch(scope, (value) => {
    if (state.value.scope === value) return
    state.value.scope = value
    state.value.rows = []
    state.value.total = 0
    state.value.lastPage = 0
    if (append) page.value = 1
  }, { immediate: true, flush: 'sync' })
  const query = computed(() => ({ ...toValue(options.query), page: page.value, pageSize: pageSize.value }))
  const read = useRequestFetch() as unknown as (url: string, opts: { query: Record<string, unknown>; signal: AbortSignal }) => Promise<P>
  const request = useAsyncData(
    computed(() => `${options.key}:${enabled.value}:${scope.value}:${page.value}`),
    async (_app, { signal }) => {
      const identity = scope.value
      const version = revision.value
      const params = { ...query.value }
      const result = enabled.value ? await read(url, { query: params, signal }) : null
      return { scope: identity, revision: version, requestedPage: params.page, result }
    },
  )
  const data = computed(() => {
    const value = request.data.value
    return enabled.value && value?.scope === scope.value && value.revision === revision.value && value.requestedPage === page.value ? value.result : null
  })
  watch([data, request.status], ([value, status]) => {
    if (!value || status !== 'success' || (append && dirty.value)) return
    if (value.page !== page.value) { page.value = value.page; return }
    if (append) {
      const merged = new Map((value.page === 1 ? [] : state.value.rows).map((row) => [row.id, row]))
      for (const row of value.rows) merged.set(row.id, row)
      state.value.rows = [...merged.values()]
      state.value.total = value.total
      state.value.lastPage = value.page
    }
  }, { immediate: true, flush: 'sync' })
  // Keep the visible snapshot until every loaded page has been rebuilt.
  async function reconcile() {
    if (!active.value || !enabled.value || !dirty.value || reconciling.value) return
    if (!append) {
      await request.refresh()
      if (request.status.value === 'success') reconciled.value = revision.value
      return
    }
    const identity = scope.value
    const version = revision.value
    const size = pageSize.value
    const loaded = Math.max(1, state.value.lastPage)
    const params = { ...toValue(options.query), pageSize: size }
    reconciling.value = true
    reconcileError.value = null
    try {
      const rebuilt = new Map<string, T>()
      let result: P | undefined
      for (let current = 1; current <= loaded; current++) {
        result = await read(url, { query: { ...params, page: current }, signal: new AbortController().signal })
        if (!enabled.value || identity !== scope.value || version !== revision.value) return
        // A shrinking collection can clamp this request onto an earlier page.
        if (result.page < current) {
          const prefix = [...rebuilt.values()].slice(0, (result.page - 1) * size)
          rebuilt.clear()
          for (const row of [...prefix, ...result.rows]) rebuilt.set(row.id, row)
          break
        }
        for (const row of result.rows) rebuilt.set(row.id, row)
        if (result.page * size >= result.total) break
      }
      if (!result) return
      state.value.rows = [...rebuilt.values()]
      state.value.total = result.total
      state.value.lastPage = result.page
      page.value = result.page
      reconciled.value = version
    } catch (error) {
      reconcileError.value = error
    } finally {
      reconciling.value = false
      if ((version !== revision.value || identity !== scope.value) && active.value) void reconcile()
    }
  }
  onDeactivated(() => { active.value = false })
  onActivated(() => { active.value = true; void reconcile() })
  watch([revision, enabled, scope], () => { void reconcile() }, { immediate: true })
  const rows = computed(() => append ? state.value.rows : data.value?.rows ?? [])
  const total = computed(() => append ? state.value.total : data.value?.total ?? 0)
  const pending = computed(() => enabled.value && (reconciling.value || request.status.value === 'pending'))
  const finished = computed(() => append && !dirty.value && state.value.lastPage > 0 && state.value.lastPage * pageSize.value >= total.value)
  function next() {
    if (!enabled.value || pending.value) return
    if (dirty.value) return reconcile()
    if (finished.value) return
    if (page.value > state.value.lastPage) return request.refresh()
    page.value++
  }
  function refresh() {
    if (append) {
      state.value.rows = []
      state.value.lastPage = 0
      state.value.total = 0
      if (page.value !== 1) { page.value = 1; return }
    }
    return request.refresh()
  }
  return { ready: request, data, rows, total, page, pageSize, pending, error: computed(() => reconcileError.value ?? request.error.value), finished, next, refresh }
}
