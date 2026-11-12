import { afterEach, expect, it, vi } from 'vitest'
import { observeTask } from '../../server/observability/task'
import { logContext } from '../../server/observability/context'
const mocks = vi.hoisted(() => ({ runSyncJob: vi.fn(), logEvent: vi.fn() }))
vi.mock('../../server/services/sync/job', () => ({ runSyncJob: mocks.runSyncJob }))
vi.mock('../../server/observability/logger', () => ({ logEvent: mocks.logEvent }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

it.each([
  [{ skipped: 'not-configured' }, 'info', 'not-configured'],
  [{ sync: { resources: [{ status: 'ok', rows: 2 }] } }, 'info', 'completed'],
  [{ sync: { resources: [{ status: 'partial', rows: 2 }] } }, 'warn', 'partial-failure'],
  [{ sync: { resources: [{ status: 'failed', rows: 0, error: 'private diagnostic' }] } }, 'warn', 'partial-failure'],
  [{ match: { error: 'private diagnostic' } }, 'warn', 'partial-failure'],
])('distinguishes skipped and incomplete jobs without logging diagnostics', async (result, level, resultCode) => {
  vi.stubGlobal('defineTask', (task: unknown) => task)
  vi.stubGlobal('qmsSyncConfig', () => ({}))
  vi.stubGlobal('adminIds', () => [])
  mocks.runSyncJob.mockResolvedValue(result)
  const { default: task } = await import('../../server/tasks/sync-qms')
  await task.run({ name: 'sync-qms', payload: {}, context: {} })
  expect(mocks.logEvent).toHaveBeenCalledWith(level, 'sync.result', expect.objectContaining({ resultCode }))
  expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('private diagnostic')
})

it('propagates task failures and clears the job context', async () => {
  const error = new Error('private diagnostic')
  await expect(observeTask('test', async () => { expect(logContext.getStore()?.taskName).toBe('test'); throw error })).rejects.toBe(error)
  expect(mocks.logEvent).toHaveBeenCalledWith('error', 'task.failed', expect.objectContaining({ durationMs: expect.any(Number) }), error)
  expect(logContext.getStore()).toBeUndefined()
})
