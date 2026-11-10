import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { mountScript, flushVue, deferred } from '../helpers/vue-script'
import { RELEASE_TYPE_TEXT } from '../../shared/releases'

const cleanup: (() => void)[] = []
const request = vi.fn()
beforeEach(() => {
  for (const key of ['ref', 'computed', 'reactive', 'watch'] as const) vi.stubGlobal(key, Vue[key])
  vi.stubGlobal('useWorkOrders', async () => ({ data: Vue.ref([]), error: Vue.ref(null) }))
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ users: [{ id: 'u1', name: 'Designer', department: 'Tech' }] }), error: Vue.ref(null) }))
  vi.stubGlobal('useMe', async () => ({ data: Vue.ref({ can: {} }) }))
  vi.stubGlobal('useFetch', async () => ({ data: Vue.ref([]), error: Vue.ref(null), refresh: vi.fn() }))
  vi.stubGlobal('RELEASE_TYPE_TEXT', RELEASE_TYPE_TEXT)
  vi.stubGlobal('RECIPIENT_ROLE_OPTIONS', [{ value: '', label: 'All' }, { value: 'DEPT_HEAD', label: 'Head' }])
  vi.stubGlobal('$fetch', request)
  vi.stubGlobal('apiError', (e: Error) => e.message)
  vi.stubGlobal('message', { warning: vi.fn(), error: vi.fn(), success: vi.fn() })
  vi.stubGlobal('uploadAttachments', vi.fn().mockResolvedValue([]))
  vi.stubGlobal('releasePost', vi.fn().mockResolvedValue({ id: 'r1', releaseNo: 'R1', recipients: 2, impact: {} }))
  request.mockReset().mockResolvedValue({ count: 2 })
})
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
async function setup() {
  const mounted = await mountScript('app/components/ReleaseCreateModal.vue', { open: false, prefill: { drawingTaskId: 'task', workOrderNumber: 'WO', description: 'Drawing' } })
  cleanup.push(mounted.unmount)
  mounted.props.open = true
  await flushVue()
  return mounted
}
it('limits task releases and submits without BOM using the resolved recipient count', async () => {
  const { state } = await setup()
  expect(state.typeEntries.map((x: string[]) => x[0])).toEqual(['DRAWING', 'CHANGE'])
  state.recipientSelection = ['user:u1', 'dept:Tech', 'role:DEPT_HEAD']
  await flushVue()
  expect(request).toHaveBeenCalledWith('/api/releases/recipients-preview', expect.objectContaining({ body: {
    type: 'DRAWING', workOrderNumber: 'WO', userIds: ['u1'], groups: [{ department: 'Tech', role: null }, { department: null, role: 'DEPT_HEAD' }],
  } }))
  expect(state.recipientCount).toBe(2)
  await state.submit()
  expect(releasePost).toHaveBeenCalledWith('/api/releases', expect.objectContaining({ bomFileId: null, drawingTaskId: 'task' }))
})
it('ignores stale recipient responses and blocks issuing after preview failure', async () => {
  const { state } = await setup()
  const old = deferred()
  request.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('No recipients'))
  state.recipientSelection = ['user:u1']
  await flushVue()
  state.recipientSelection = ['dept:Tech']
  await flushVue()
  old.resolve({ count: 99 })
  await flushVue()
  expect(state.recipientCount).toBeNull()
  expect(state.recipientError).toBe('No recipients')
  await state.submit()
  expect(releasePost).not.toHaveBeenCalled()
})
