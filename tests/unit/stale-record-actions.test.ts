import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import * as workbench from '../../shared/workbench'
import * as drawing from '../../shared/drawing'
import * as purchases from '../../shared/purchases'
import { deferred, flushVue, mountScript } from '../helpers/vue-script'

const cleanups: (() => void)[] = []
const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }
const send = vi.fn()
const fetchRelease = vi.fn()
const fetchApi = vi.fn()
const parts = Vue.ref<any[]>([])

beforeEach(() => {
  vi.clearAllMocks()
  for (const name of ['ref', 'reactive', 'computed', 'watch', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, Vue[name])
  vi.stubGlobal('useWorkOrders', async () => ({ data: Vue.ref([{ workOrderNumber: 'WO-A' }, { workOrderNumber: 'WO-B' }]) }))
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ suppliers: [], users: [] }) }))
  vi.stubGlobal('useRequestFetch', () => fetchApi)
  vi.stubGlobal('useAsyncData', (_key: unknown, _handler: unknown, options: { default: () => unknown }) => ({ data: Vue.ref(options.default()), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }))
  vi.stubGlobal('useFetch', async () => ({ data: parts, refresh: vi.fn() }))
  vi.stubGlobal('usePagedList', () => ({ ready: Promise.resolve(), data: Vue.ref({ rows: [], stats: null, groups: {} }), rows: Vue.ref([]), total: Vue.ref(0), pending: Vue.ref(false), error: Vue.ref(null), finished: Vue.ref(false), refresh: vi.fn() }))
  vi.stubGlobal('message', message)
  vi.stubGlobal('apiError', (e: Error) => e.message)
  vi.stubGlobal('dayText', (s: string) => s?.slice(0, 10) ?? '')
  vi.stubGlobal('dayAfter', () => '2026-10-28')
  vi.stubGlobal('purchaseSend', send)
  vi.stubGlobal('drawingSend', send)
  vi.stubGlobal('drawingResultText', (_: unknown, text: string) => text)
  vi.stubGlobal('fetchRelease', fetchRelease)
  vi.stubGlobal('releasePost', send)
  vi.stubGlobal('refreshNuxtData', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('$fetch', fetchApi)
  vi.stubGlobal('showFailToast', message.error)
  vi.stubGlobal('showSuccessToast', message.success)
  vi.stubGlobal('showToast', message.warning)
  fetchApi.mockReset().mockResolvedValue({ supplierId: 'supplier' })
  send.mockReset().mockResolvedValue({})
  fetchRelease.mockReset()
  parts.value = []
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})
async function mount(file: string, props: Record<string, unknown> = {}) {
  const result = await mountScript(file, props, { '#shared/drawing': drawing, '#shared/workbench': workbench, '#shared/purchases': purchases })
  cleanups.push(result.unmount)
  return result
}

function record(id: string) {
  return { id, workOrderNumber: `WO-${id}`, materialName: `Material ${id}`, componentName: `Drawing ${id}`, partId: `part-${id}`, partIds: [`part-${id}`], quantity: 1, needDate: '2026-11-01', planDate: '2026-11-01', planNodeId: `node-${id}`, status: 'OPEN', needsCustomerConfirm: false }
}

describe.each([
  ['PurchaseEditModal', 'line', 'materialName', 'purchases'],
  ['DrawingEditModal', 'task', 'componentName', 'drawings'],
])('%s record identity', (component, prop, field, endpoint) => {
  it('loads an initially open record and replaces its form when switching while open', async () => {
    const { state, props, events } = await mount(`app/components/${component}.vue`, { open: true, [prop]: record('A') })
    expect(state.form[field]).toContain('A')
    state.form[field] = 'Edited A'
    props[prop] = record('B')
    await flushVue()
    expect(state.form[field]).toContain('B')
    expect(state.form.planNodeId).toBe('node-B')
    if (prop === 'task') expect(state.form.partIds).toEqual(['part-B'])
    else expect(state.form.partId).toBe('part-B')
    await state.submit()
    expect(send).toHaveBeenCalledWith(`/api/${endpoint}/B`, 'PATCH', expect.objectContaining({ [field]: expect.stringContaining('B') }))
    expect(events).toEqual([['B']])
  })

  it('does not let an old save close the newly selected record or clear its saving state', async () => {
    const a = deferred(), b = deferred()
    send.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { state, props, events } = await mount(`app/components/${component}.vue`, { open: true, [prop]: record('A') })
    const savingA = state.submit()
    props[prop] = record('B')
    await flushVue()
    const savingB = state.submit()
    a.resolve({})
    await savingA
    expect(events).toEqual([])
    expect(state.saving).toBe(true)
    b.resolve({})
    await savingB
    expect(events).toEqual([['B']])
  })

  it('ignores an old error after closing and reopening the same record', async () => {
    const request = deferred()
    send.mockReturnValueOnce(request.promise)
    const { state, props, events } = await mount(`app/components/${component}.vue`, { open: true, [prop]: record('A') })
    const saving = state.submit()
    props.open = false
    await flushVue()
    props.open = true
    await flushVue()
    request.reject(new Error('old save'))
    await saving
    expect(message.error).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(state.saving).toBe(false)
  })

  it('loads a new preset while open and clears dependent fields on a manual work-order change', async () => {
    const { state, props } = await mount(`app/components/${component}.vue`, { open: true, [prop]: null, workOrderNumber: 'WO-A', presetNode: { id: 'node-A', planDate: '2026-11-01' } })
    props.workOrderNumber = 'WO-B'
    props.presetNode = { id: 'node-B', planDate: '2026-11-02' }
    await flushVue()
    expect(state.form.planNodeId).toBe('node-B')
    state.form.workOrderNumber = 'WO-A'
    expect(state.form.planNodeId).toBeNull()
    if (prop === 'task') expect(state.form.partIds).toEqual([])
    else expect(state.form.partId).toBeUndefined()
  })

  it('preserves unsaved edits when the same record is refreshed', async () => {
    const { state, props } = await mount(`app/components/${component}.vue`, { open: true, [prop]: record('A') })
    state.form[field] = 'Unsaved edit'
    props[prop] = { ...record('A'), note: 'refreshed' }
    await flushVue()
    expect(state.form[field]).toBe('Unsaved edit')
  })

  it('ignores a save completion after unmount', async () => {
    const request = deferred()
    send.mockReturnValueOnce(request.promise)
    const { state, events, unmount } = await mount(`app/components/${component}.vue`, { open: true, [prop]: record('A') })
    const saving = state.submit()
    unmount()
    request.resolve({})
    await saving
    expect(events).toEqual([])
    expect(message.success).not.toHaveBeenCalled()
  })
})

describe('purchase pagination selection', () => {
  it('preserves cross-page selections and clears them only when filters change', async () => {
    const route = Vue.reactive({ query: { page: '1', view: 'open' } })
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useMe', async () => ({ data: Vue.ref({}) }))
    vi.stubGlobal('useListLayout', () => Vue.ref('table'))
    const { state } = await mount('app/pages/purchases.vue')
    state.rowSelectionFor([record('A')]).onChange(['A'])
    route.query = { page: '2', view: 'open' }
    await flushVue()
    expect(state.selectedKeys).toEqual(['A'])
    state.rowSelectionFor([record('B')]).onChange(['A', 'B'])
    expect(state.selectedRows.map((r: any) => r.id)).toEqual(['A', 'B'])
    state.rowSelectionFor([]).onChange(Array.from({ length: 51 }, (_, i) => String(i)))
    expect(state.selectedKeys).toEqual(['A', 'B'])
    expect(message.warning).toHaveBeenCalledWith('一张付款申请最多关联 50 项')
    route.query = { page: '1', view: 'arrived' }
    await flushVue()
    expect(state.selectedKeys).toEqual([])
    expect(state.selection.size).toBe(0)
  })
})

describe('payment material hydration', () => {
  it('keeps a newly selected option when preselected records arrive later', async () => {
    const request = deferred()
    fetchApi.mockReturnValue(request.promise)
    const { state } = await mount('app/components/PaymentCreateModal.vue', { open: true, lines: [record('A')] })
    state.choiceRows = [{ ...record('B'), workOrderNumber: 'WO-A' }]
    state.form.purchaseLineIds = ['A', 'B']
    await flushVue()
    request.resolve({ rows: [record('A')] })
    await flushVue()
    expect(state.lineOptions.map((r: any) => r.value).sort()).toEqual(['A', 'B'])
  })

  it('ignores hydration from the previous work order', async () => {
    const request = deferred()
    fetchApi.mockReturnValue(request.promise)
    const { state } = await mount('app/components/PaymentCreateModal.vue', { open: true, lines: [record('A')] })
    state.form.workOrderNumber = 'WO-B'
    state.onWorkOrderChange()
    request.resolve({ rows: [record('A')] })
    await flushVue()
    expect(state.form.purchaseLineIds).toEqual([])
    expect(state.picked.size).toBe(0)
  })
})

describe.each(['purchases', 'drawings'])('%s reminder navigation', (page) => {
  async function setup() {
    const route = Vue.reactive({ query: { id: 'A' as string | undefined } })
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useMe', async () => ({ data: Vue.ref({}) }))
    vi.stubGlobal('canDo', () => true)
    vi.stubGlobal('useListLayout', () => Vue.ref('group'))
    vi.stubGlobal('useFetch', async () => ({ data: Vue.ref({ rows: [], stats: null }), pending: Vue.ref(false), refresh: vi.fn() }))
    const fetch = vi.fn()
    vi.stubGlobal(page === 'purchases' ? 'fetchPurchase' : 'fetchDrawing', fetch)
    return { route, fetch }
  }

  it('keeps a manual selection when an older reminder request returns', async () => {
    const { fetch } = await setup()
    const request = deferred()
    fetch.mockReturnValue(request.promise)
    const { state } = await mount(`app/pages/${page}.vue`)
    state.openEdit(record('B'))
    request.resolve(record('A'))
    await flushVue()
    expect(state.editing.id).toBe('B')
  })

  it('does not reopen after closing while a reminder is loading', async () => {
    const { fetch } = await setup()
    const request = deferred()
    fetch.mockReturnValue(request.promise)
    const { state } = await mount(`app/pages/${page}.vue`)
    state.closeEdit()
    request.resolve(record('A'))
    await flushVue()
    expect(state.editOpen).toBe(false)
  })

  it('ignores errors from a previous reminder after navigation', async () => {
    const { route, fetch } = await setup()
    const a = deferred(), b = deferred()
    fetch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { state } = await mount(`app/pages/${page}.vue`)
    route.query.id = 'B'
    await flushVue()
    b.resolve(record('B'))
    a.reject(new Error('old reminder'))
    await flushVue()
    expect(state.editing.id).toBe('B')
    expect(message.error).not.toHaveBeenCalled()
  })
})

const detail = (id: string) => ({ id, releaseNo: id, permissions: { sign: true, void: true, confirmChange: true }, myReceipt: { id: `receipt-${id}` } })
describe('ReleaseDrawer request ordering', () => {
  it('clears old content immediately and ignores an older success after the new response', async () => {
    const a = deferred(), b = deferred()
    fetchRelease.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { state, props } = await mount('app/components/ReleaseDrawer.vue', { id: 'A' })
    props.id = 'B'
    await flushVue()
    expect(state.detail).toBeNull()
    await state.sign()
    expect(send).not.toHaveBeenCalled()
    b.resolve(detail('B'))
    await flushVue()
    a.resolve(detail('A'))
    await flushVue()
    expect(state.detail.id).toBe('B')
    send.mockImplementationOnce(async () => { fetchRelease.mockResolvedValue(detail('B')) })
    await state.sign()
    expect(send).toHaveBeenCalledWith('/api/receipts/receipt-B/sign', {})
  })

  it('does not let an old failure end the current loading state or replace its error', async () => {
    const a = deferred(), b = deferred()
    fetchRelease.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { state, props } = await mount('app/components/ReleaseDrawer.vue', { id: 'A' })
    props.id = 'B'
    await flushVue()
    a.reject(new Error('A failed'))
    await flushVue()
    expect(state.loading).toBe(true)
    expect(state.loadError).toBe('')
    b.reject(new Error('B failed'))
    await flushVue()
    expect(state.loadError).toBe('B failed')
  })

  it('clears dialogs and invalidates pending loads on close', async () => {
    const request = deferred()
    fetchRelease.mockReturnValue(request.promise)
    const { state, props } = await mount('app/components/ReleaseDrawer.vue', { id: 'A' })
    state.rejecting = true
    state.reason = 'reason for A'
    props.id = null
    await flushVue()
    request.resolve(detail('A'))
    await flushVue()
    expect(state.detail).toBeNull()
    expect(state.rejecting).toBe(false)
    expect(state.reason).toBe('')
    expect(state.loading).toBe(false)
  })

  it('invalidates a void confirmation after switching away and back to the same record', async () => {
    const confirm = vi.fn()
    vi.stubGlobal('Modal', { confirm })
    fetchRelease.mockImplementation(async (id) => detail(id))
    const { state, props } = await mount('app/components/ReleaseDrawer.vue', { id: 'A' })
    state.voidIt()
    props.id = 'B'
    await flushVue()
    props.id = 'A'
    await flushVue()
    await confirm.mock.calls[0]![0].onOk()
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores old action callbacks after switching to a new record', async () => {
    const action = deferred()
    fetchRelease.mockImplementation(async (id) => detail(id))
    send.mockReturnValueOnce(action.promise)
    const { state, props, events } = await mount('app/components/ReleaseDrawer.vue', { id: 'A' })
    const signing = state.sign()
    props.id = 'B'
    await flushVue()
    action.resolve({})
    await signing
    expect(state.detail.id).toBe('B')
    expect(events).toEqual([])
    expect(fetchRelease).toHaveBeenCalledTimes(2)
  })
})

const part = (id: string, wo = 'WO-A') => ({ id, workOrderNumber: wo, steps: [{ id: `step-${id}`, mode: 'EXTERNAL_OUTSOURCE', status: 'PENDING', supplierId: 'supplier' }] })
describe('mobile send selection', () => {
  it('clears the hidden step and all dependent values when changing the part', async () => {
    const { state } = await mount('app/pages/m/send.vue')
    state.workOrderNumber = 'WO-A'
    state.parts = [part('A'), part('B')]
    state.choosePart('A')
    state.promisedReturnDate = '2026-11-01'
    state.note = 'material for A'
    expect(state.canSubmit).toBe(true)
    state.choosePart('')
    expect([state.stepId, state.supplierId, state.promisedReturnDate, state.note]).toEqual(['', '', '', ''])
    expect(state.canSubmit).toBe(false)
    await state.submit()
    expect(fetchApi.mock.calls.filter(([url]) => String(url).endsWith('/send'))).toEqual([])
    state.choosePart('B')
    expect(state.stepId).toBe('step-B')
    expect(state.canSubmit).toBe(false)
  })

  it('requires a visible pending external step belonging to the selected work order', async () => {
    const { state } = await mount('app/pages/m/send.vue')
    state.workOrderNumber = 'WO-A'
    state.parts = [part('A')]
    state.choosePart('A')
    state.promisedReturnDate = '2026-11-01'
    state.partId = ''
    expect(state.canSubmit).toBe(false)
    state.partId = 'A'
    state.parts[0].steps[0].status = 'OUT'
    expect(state.canSubmit).toBe(false)
    state.parts[0].steps[0].status = 'PENDING'
    state.workOrderNumber = 'WO-B'
    expect(state.canSubmit).toBe(false)
  })

  it('ignores old work-order results and delayed todo initialization after manual selection', async () => {
    const initial = deferred(), a = deferred(), b = deferred()
    vi.stubGlobal('useRoute', () => ({ query: { stepId: 'old-todo' } }))
    fetchApi.mockImplementation((url, options) => url === '/api/last-supplier' ? initial.promise : options.query.workOrderNumber === 'WO-A' ? a.promise : b.promise)
    const { state } = await mount('app/pages/m/send.vue')
    state.chooseWorkOrder('WO-A')
    state.chooseWorkOrder('WO-B')
    b.resolve([part('B', 'WO-B')])
    await flushVue()
    a.resolve([part('A')])
    initial.resolve({ supplierId: 'supplier' })
    await flushVue()
    expect(state.parts.map((p: any) => p.id)).toEqual(['B'])
    expect(state.workOrderNumber).toBe('WO-B')
    expect(fetchApi).not.toHaveBeenCalledWith('/api/steps/old-todo')
  })

  it('keeps a new selection when the previous send finishes', async () => {
    const sending = deferred()
    const { state } = await mount('app/pages/m/send.vue')
    state.workOrderNumber = 'WO-A'
    state.parts = [part('A'), part('B')]
    state.choosePart('A')
    state.promisedReturnDate = '2026-11-01'
    fetchApi.mockReturnValueOnce(sending.promise)
    const submit = state.submit()
    state.choosePart('B')
    sending.resolve({})
    await submit
    expect(state.stepId).toBe('step-B')
    expect(message.success).not.toHaveBeenCalled()
  })
})
