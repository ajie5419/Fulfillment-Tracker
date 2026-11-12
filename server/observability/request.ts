import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { getResponseStatus, setResponseHeader, type H3Event } from 'h3'
import { logContext } from './context'
import { logEvent } from './logger'

interface RequestObservation { requestId: string; started: number; finished?: boolean; errorLogged?: boolean }
declare module 'h3' { interface H3EventContext { observation?: RequestObservation } }

export function beginRequest(event: H3Event) {
  const state = event.context.observation ??= { requestId: randomUUID(), started: performance.now() }
  if (!event.node.res.headersSent) setResponseHeader(event, 'x-request-id', state.requestId)
  return state
}

export function withRequestContext<T>(event: H3Event, run: () => T): T {
  const { requestId } = beginRequest(event)
  return logContext.run({ requestId, actorId: event.context.user?.qmsUserId }, run)
}

function requestFields(event: H3Event) {
  const state = beginRequest(event)
  return {
    requestId: state.requestId, actorId: event.context.user?.qmsUserId,
    method: event.method, route: event.context.matchedRoute?.path ?? 'unmatched',
    statusCode: getResponseStatus(event), durationMs: Math.round((performance.now() - state.started) * 100) / 100,
  }
}

export function recordRequestError(event: H3Event, error: unknown, statusCode = 500) {
  const state = beginRequest(event)
  if (state.errorLogged) return
  state.errorLogged = true
  logEvent(statusCode >= 500 ? 'error' : 'warn', 'request.failed', { ...requestFields(event), statusCode }, error)
}

export function finishRequest(event: H3Event) {
  const state = beginRequest(event)
  if (state.finished) return
  state.finished = true
  const fields = requestFields(event)
  logEvent(fields.statusCode >= 500 ? 'error' : fields.statusCode >= 400 ? 'warn' : 'info', 'request.completed', fields)
}
