import { performance } from 'node:perf_hooks'
import { withJobContext } from './context'
import { logEvent } from './logger'

export function observeTask<T>(name: string, run: () => Promise<T>): Promise<T> {
  return withJobContext(name, async () => {
    const start = performance.now()
    logEvent('info', 'task.started')
    try {
      const result = await run()
      logEvent('info', 'task.completed', { durationMs: Math.round(performance.now() - start) })
      return result
    } catch (error) {
      logEvent('error', 'task.failed', { durationMs: Math.round(performance.now() - start) }, error)
      throw error
    }
  })
}
