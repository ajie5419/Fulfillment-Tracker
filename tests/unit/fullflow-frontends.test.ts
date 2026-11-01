import { readFileSync } from 'node:fs'
import { parse } from 'vue/compiler-sfc'
import * as Vue from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { mountScript } from '../helpers/vue-script'

it.each(['index', 'drawings', 'payments', 'releases', 'settings', 'outsource', 'risks', 'parts', 'process', 'kitting', 'purchases', 'dev'])('%s has a single page root for Nuxt navigation', page => {
  const { descriptor, errors } = parse(readFileSync(`app/pages/${page}.vue`, 'utf8'))
  expect(errors).toEqual([])
  expect(descriptor.template!.ast!.children.filter(node => node.type === 1)).toHaveLength(1)
})
afterEach(() => vi.unstubAllGlobals())
it('desktop finish action immediately opens the shared finish state', async () => {
  for (const key of ['ref', 'computed', 'reactive'] as const) vi.stubGlobal(key, Vue[key])
  // No async master-data dependency is allowed before exposing the action host.
  vi.stubGlobal('useMaster', () => ({ data: Vue.ref({ users: [] }) }))
  const view = await mountScript('app/components/StepActionHost.vue')
  view.state.run('finish', { stepId: 'step', partName: '支腿', processName: '下料', quantity: 4, doneQty: 1 })
  expect(view.state.finishing).toEqual({ id: 'step', title: '支腿 · 下料', quantity: 4, doneQty: 1 })
  view.unmount()
})

it.each([null, 'initial'])('issue drawer uses the authenticated request fetch for initial id %s and close/reopen', async (initialId) => {
  for (const key of ['ref', 'computed', 'reactive', 'watch'] as const) vi.stubGlobal(key, Vue[key])
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ users: [] }) }))
  vi.stubGlobal('useIssueOptions', async () => ({ data: Vue.ref({}) }))
  vi.stubGlobal('NOTE_REQUIRED', [])
  const requests: string[] = []
  vi.stubGlobal('$fetch', () => { throw new Error('unscoped SSR fetch must not be used') })
  vi.stubGlobal('useRequestFetch', () => async (url: string) => { requests.push(url); return { id: url.split('/').at(-1) } })
  vi.stubGlobal('useAsyncData', (key: Vue.ComputedRef<string>, handler: () => Promise<unknown>) => {
    const data = Vue.ref(), pending = Vue.ref(false), error = Vue.ref(null)
    let seq = 0
    async function refresh() {
      const current = ++seq
      data.value = null
      pending.value = true
      const result = await handler()
      if (seq !== current) return
      data.value = result
      pending.value = false
    }
    Vue.watch(key, refresh, { immediate: true, flush: 'sync' })
    return { data, pending, error, refresh }
  })
  const view = await mountScript('app/components/IssueDrawer.vue', { id: initialId })
  expect(view.state.detail?.id ?? null).toBe(initialId)
  const { flushVue } = await import('../helpers/vue-script')
  view.props.id = 'A'; await flushVue()
  expect(view.state.detail.id).toBe('A')
  view.props.id = null; await flushVue()
  expect(view.state.detail).toBeNull()
  view.props.id = 'A'; await flushVue()
  expect(view.state.detail.id).toBe('A')
  view.props.id = 'B'; await flushVue()
  expect(view.state.detail.id).toBe('B')
  expect(requests).toEqual([...(initialId ? ['/api/issues/initial'] : []), '/api/issues/A', '/api/issues/A', '/api/issues/B'])
  view.unmount()
})

it('drawings keeps filtered rows identical in grouped/table layouts and isolates request keys', async () => {
  const { flushVue } = await import('../helpers/vue-script')
  const workbench = await import('../../shared/workbench')
  const drawing = await import('../../shared/drawing')
  for (const key of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(key, Vue[key])
  const route = Vue.reactive({ query: { view: 'all' } as Record<string, unknown> })
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace: ({ query }: { query: Record<string, unknown> }) => { route.query = query } }))
  vi.stubGlobal('useWorkOrders', async () => ({ data: Vue.ref([]) }))
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ users: [] }) }))
  vi.stubGlobal('useMe', async () => ({ data: Vue.ref({}) }))
  vi.stubGlobal('canDo', () => false)
  vi.stubGlobal('dayAfter', () => '2026-10-29')
  vi.stubGlobal('useListLayout', () => Vue.ref('group'))
  let options: any
  const pending = Vue.ref(false)
  const data = Vue.ref({ rows: [{ id: 'a', workOrderNumber: 'WO' }, { id: 'b', workOrderNumber: 'WO' }, { id: 'c', workOrderNumber: 'WO2' }], total: 3, stats: { drawn: 1, customerPending: 0 } })
  let requestQuery: any
  vi.stubGlobal('useRequestFetch', () => (_url: string, opts: any) => { requestQuery = opts.query; return Promise.resolve(data.value) })
  vi.stubGlobal('useAsyncData', (key: any, handler: any) => {
    options = { key }
    Vue.watch(key, () => handler(null, { signal: new AbortController().signal }), { immediate: true })
    return { data, pending, error: Vue.ref(null), refresh: vi.fn() }
  })
  vi.stubGlobal('useFetch', (_url: string, opts: any) => ({ data: Vue.ref(opts.default()), pending: Vue.ref(false), refresh: vi.fn() }))
  const view = await mountScript('app/pages/drawings.vue', {}, { '#shared/workbench': workbench, '#shared/drawing': drawing })
  const ids = () => view.state.tables.flatMap((g: any) => g.rows.map((r: any) => r.id))
  expect(ids()).toEqual(['a', 'b', 'c'])
  const allKey = options.key.value
  view.state.applyView('drawn'); await flushVue()
  expect(requestQuery.view).toBe('drawn')
  expect(options.key.value).not.toBe(allKey)
  pending.value = true; await flushVue()
  expect(ids()).toEqual([])
  data.value = { ...data.value, rows: [{ id: 'b', workOrderNumber: 'WO' }], total: 1 }
  pending.value = false; await flushVue()
  expect(ids()).toEqual(['b'])
  expect(view.state.rows.length).toBe(data.value.total)
  expect(data.value.total).toBe(data.value.stats.drawn + data.value.stats.customerPending)
  view.state.layout = 'table'; await flushVue()
  expect(ids()).toEqual(['b'])
  view.state.layout = 'group'; await flushVue()
  expect(ids()).toEqual(['b'])
  route.query = { view: 'all', wo: 'WO2', owner: 'owner' }; await flushVue()
  expect(requestQuery).toMatchObject({ view: 'all', workOrderNumber: 'WO2', ownerId: 'owner' })
  view.unmount()
})

it('mobile issue deep-link detail fetch forwards the SSR request', () => {
  const source = readFileSync('app/pages/m/issues.vue', 'utf8')
  expect(source).toContain('const requestFetch = useRequestFetch()')
  const fetcher = source.slice(source.indexOf('await useAsyncData<Detail'), source.indexOf('watch([tab, selected]'))
  expect(fetcher).toContain('clientRequest(`/api/issues/${encodeURIComponent(selected.value)}`, undefined, requestFetch)')
  expect(fetcher).not.toContain('$fetch')
})

it.each(['PlanNodeSelect', 'PartTemplateModal', 'BomImportModal', 'SendStepModal', 'RouteBatchModal', 'WorkOrderEditModal', 'PaymentCreateModal'])('%s scopes initial watcher reads to the authenticated request', name => {
  const source = readFileSync(`app/components/${name}.vue`, 'utf8')
  expect(source).toContain('useRequestFetch()')
  const initial = source.slice(0, source.indexOf('{ immediate: true }'))
  expect(initial).not.toMatch(/(?:await\s+\$fetch|const (?:get|read) = \$fetch)/)
})

it.each(['/settings', '/drawings', '/templates', '/wo/WO-001', '/'])('route %s has a title independent of menu permissions', async path => {
  for (const key of ['ref', 'computed', 'watch'] as const) vi.stubGlobal(key, Vue[key])
  vi.stubGlobal('onMounted', () => {})
  vi.stubGlobal('onBeforeUnmount', () => {})
  vi.stubGlobal('useMe', async () => ({ data: Vue.ref({ menu: [], can: {} }) }))
  const route = Vue.ref({ path })
  vi.stubGlobal('useRouter', () => ({ currentRoute: route }))
  vi.stubGlobal('useUnreadCount', () => ({ data: Vue.ref({}), refresh: vi.fn() }))
  const view = await mountScript('app/layouts/default.vue')
  const expected: Record<string, string> = { '/settings': '设置', '/drawings': '设计任务', '/templates': '工序路线模板', '/wo/WO-001': '工单详情', '/': '工作台' }
  expect(view.state.current.label).toBe(expected[path])
  expect(view.state.menu.some((item: any) => item.key === '/settings')).toBe(false)
  expect(view.state.selected).toEqual(path === '/' ? ['/'] : path.startsWith('/wo/') ? ['/board'] : [])
  route.value = { path: '/calendar' }
  await Vue.nextTick()
  expect(view.state.current.label).toBe('项目日历')
  expect(view.state.selected).toEqual(['/calendar'])
  view.unmount()
})

it('release drawer forwards the scoped request through its detail helper', () => {
  const source = readFileSync('app/components/ReleaseDrawer.vue', 'utf8')
  expect(source).toContain('const requestFetch = useRequestFetch()')
  expect(source).toContain('fetchRelease(id, requestFetch)')
  const helper = readFileSync('app/composables/useReleases.ts', 'utf8')
  expect(helper).toContain('fetchRelease(id: string, request?: ClientFetch)')
  expect(helper).toContain('clientRequest(`/api/releases/${encodeURIComponent(id)}`, undefined, request)')
})
