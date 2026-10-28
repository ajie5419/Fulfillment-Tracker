import { computed, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import type { PageResult } from '#shared/pagination'
import { DEFAULT_PAGE_SIZE } from '#shared/pagination'

/** Nuxt owns requests and SSR transfer. This adapter only joins successful pages
 * for one filter identity; it does not implement another request cache. */
export function usePagedList<T extends { id: string }, P extends PageResult<T> = PageResult<T>>(
  url: string,
  options: { key: string; query: MaybeRefOrGetter<Record<string, unknown>>; mode?: 'replace' | 'append'; page?: Ref<number>; pageSize?: Ref<number>; enabled?: MaybeRefOrGetter<boolean> },
) {
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
      const params = { ...query.value }
      const result = enabled.value ? await read(url, { query: params, signal }) : null
      return { scope: identity, requestedPage: params.page, result }
    },
  )
  const data = computed(() => {
    const value = request.data.value
    return enabled.value && value?.scope === scope.value && value.requestedPage === page.value ? value.result : null
  })
  watch([data, request.status], ([value, status]) => {
    if (!value || status !== 'success') return
    if (value.page !== page.value) { page.value = value.page; return }
    if (append) {
      const merged = new Map((value.page === 1 ? [] : state.value.rows).map((row) => [row.id, row]))
      for (const row of value.rows) merged.set(row.id, row)
      state.value.rows = [...merged.values()]
      state.value.total = value.total
      state.value.lastPage = value.page
    }
  }, { immediate: true, flush: 'sync' })
  const rows = computed(() => append ? state.value.rows : data.value?.rows ?? [])
  const total = computed(() => append ? state.value.total : data.value?.total ?? 0)
  const pending = computed(() => enabled.value && request.status.value === 'pending')
  const finished = computed(() => append && state.value.lastPage > 0 && state.value.lastPage * pageSize.value >= total.value)
  function next() {
    if (!enabled.value || pending.value || finished.value) return
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
  return { ready: request, data, rows, total, page, pageSize, pending, error: request.error, finished, next, refresh }
}
