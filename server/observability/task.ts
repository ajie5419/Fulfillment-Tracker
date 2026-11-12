import { performance } from 'node:perf_hooks'
import { withJobContext } from './context'
import { logEvent } from './logger'
import { taskLastStart, taskLastFinish, taskRunning } from './metrics'

const TASK_WARNING_MS = 120_000

export function observeTask<T>(name: string, run: () => Promise<T>): Promise<T> {
  return withJobContext(name, async () => {
    const start = performance.now()
    taskLastStart.set({ task: name }, Date.now() / 1000)
    taskRunning.inc({ task: name })
    // Observe a stall without cancelling a transaction or launching a duplicate job.
    const overdue = setTimeout(() => logEvent('error', 'task.overdue', { durationMs: TASK_WARNING_MS }), TASK_WARNING_MS)
    overdue.unref()
    logEvent('info', 'task.started')
    try {
      const result = await run()
      logEvent('info', 'task.completed', { durationMs: Math.round(performance.now() - start) })
      return result
    } catch (error) {
      logEvent('error', 'task.failed', { durationMs: Math.round(performance.now() - start) }, error)
      throw error
    } finally {
      clearTimeout(overdue)
      taskRunning.dec({ task: name })
      taskLastFinish.set({ task: name }, Date.now() / 1000)
    }
  })
}
