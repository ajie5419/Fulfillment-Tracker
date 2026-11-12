import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface LogContext { requestId: string; actorId?: string; taskName?: string }
export const logContext = new AsyncLocalStorage<LogContext>()

/** A new scope prevents concurrent jobs from inheriting another request's identity. */
export function withJobContext<T>(taskName: string, run: () => T): T {
  return logContext.run({ requestId: randomUUID(), taskName }, run)
}
