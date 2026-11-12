import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import dayjs from 'dayjs'
import * as mobileTodo from '../../shared/mobile-todo'
import * as validation from '../../shared/plan-validation'
import { mountScript, deferred } from '../helpers/vue-script'

const fetch = vi.fn()
const node = { id: 'node', name: '结构图纸', code: '2.1', dept: 'TECH', startDate: '2026-11-01', planDate: '2026-12-01', canSplit: true, tasks: [] }
beforeEach(() => {
  fetch.mockReset().mockResolvedValue({ id: 'task' })
  for (const key of ['ref', 'computed', 'reactive'] as const) vi.stubGlobal(key, Vue[key])
  vi.stubGlobal('apiFetch', fetch)
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ users: [{ id: 'designer', name: '设计员', department: '技术部', businessDept: 'TECH' }] }) }))
  vi.stubGlobal('message', { warning: vi.fn(), success: vi.fn(), error: vi.fn() })
  vi.stubGlobal('apiError', (e: Error) => e.message)
})
afterEach(() => vi.unstubAllGlobals())
const open = (extra = {}) => mountScript('app/components/PlanNodeWork.vue', { node, wo: 'WO', canCreate: { drawing: true }, ...extra }, { dayjs: { default: dayjs }, '#shared/mobile-todo': mobileTodo, '#shared/plan-validation': validation })

it('defaults to a linked design task, assigns its owner and prevents duplicate clicks', async () => {
  const v = await open()
  v.state.openSplit()
  expect(v.state.taskKind).toBe('drawing')
  expect(v.state.taskStart).toBe('2026-11-01')
  Object.assign(v.state.taskForm, { name: '车架', ownerId: 'designer' })
  const pending = deferred()
  fetch.mockReturnValueOnce(pending.promise)
  const saving = v.state.saveTask()
  await v.state.saveTask()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith('/api/drawings', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ workOrderNumber: 'WO', planNodeId: 'node', componentName: '车架', ownerId: 'designer', startDate: '2026-11-01', planDate: '2026-12-01' }) }))
  pending.resolve({ id: 'drawing' })
  await saving
  expect(v.state.taskOpen).toBe(false)
  expect(v.events).toEqual([['changed']])
  v.unmount()
})

it('only creates a general task when explicitly selected; existing general tasks stay general', async () => {
  const v = await open()
  v.state.openSplit()
  Object.assign(v.state.taskForm, { name: '资料整理', ownerId: 'designer' })
  v.state.taskKind = 'task'
  await v.state.saveTask()
  expect(fetch).toHaveBeenCalledWith('/api/plan/nodes/node/tasks', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ name: '资料整理' }) }))
  v.state.openTask({ id: 'old', name: '旧任务', ownerId: 'designer', planDate: '2026-12-01' })
  expect(v.state.taskKind).toBe('task')
  await v.state.saveTask()
  expect(fetch).toHaveBeenLastCalledWith('/api/plan/tasks/old', expect.objectContaining({ method: 'PATCH' }))
  v.unmount()
})

it('validates assignment and date order; read-only views have no split options', async () => {
  const v = await open()
  v.state.openSplit()
  Object.assign(v.state.taskForm, { name: '车架', ownerId: 'designer' })
  v.state.taskStart = '2026-12-02'
  await v.state.saveTask()
  expect(fetch).not.toHaveBeenCalled()
  v.unmount()
  const read = await open({ viewOnly: true })
  expect(read.state.splitOptions).toEqual([])
  expect(read.state.canAddTask).toBe(false)
  read.unmount()
})
