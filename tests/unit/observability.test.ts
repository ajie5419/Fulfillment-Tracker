import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogWriter } from '../../server/observability/logger'
import { logContext, withJobContext } from '../../server/observability/context'
import { beginRequest, finishRequest, recordRequestError, withRequestContext } from '../../server/observability/request'
import apiErrorHandler from '../../server/api-error'

const captured = vi.hoisted(() => vi.fn())
vi.mock('../../server/observability/logger', async original => ({ ...await original<object>(), logEvent: captured }))
const require = createRequire(import.meta.url)
const h3 = createRequire(require.resolve('nuxt/package.json'))('h3') as typeof import('h3')
afterEach(() => vi.clearAllMocks())

describe('structured logging boundaries', () => {
  it('drops raw payloads, headers, SQL diagnostics and error causes even when supplied at runtime', () => {
    const lines: string[] = []
    const write = createLogWriter({ write: line => { lines.push(line) } })
    const secret = 'synthetic-secret-must-not-leak'
    const error = Object.assign(new Error(`SQL password=${secret}`), { code: 'P2002', cause: { token: secret } })
    write('error', 'request.failed', { module: 'payments', body: { password: secret }, headers: { cookie: secret }, password: secret } as never, error)
    expect(lines.join('')).not.toContain(secret)
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'request.failed', module: 'payments', errorType: 'Error', errorCode: 'P2002' })
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('body')
  })

  it('keeps concurrent async identities isolated and jobs independent', async () => {
    const lines: string[] = []
    const write = createLogWriter({ write: line => { lines.push(line) } })
    await Promise.all(['a', 'b'].map(requestId => logContext.run({ requestId, actorId: requestId }, async () => {
      await new Promise(resolve => setTimeout(resolve, requestId === 'a' ? 5 : 1))
      write('info', 'test')
      withJobContext('sync-qms', () => {
        expect(logContext.getStore()?.actorId).toBeUndefined()
        expect(logContext.getStore()?.requestId).not.toBe(requestId)
      })
    })))
    expect(lines.map(line => JSON.parse(line)).map(x => [x.requestId, x.actorId])).toEqual([['b', 'b'], ['a', 'a']])
    expect(logContext.getStore()).toBeUndefined()
  })

  it('returns fresh IDs, logs route templates without query secrets, and completes only once', async () => {
    const app = h3.createApp({ onRequest: event => { beginRequest(event) }, onAfterResponse: finishRequest })
    app.use(h3.createRouter().get('/api/item/:id', h3.defineEventHandler(event => withRequestContext(event, () => {
      finishRequest(event)
      return { requestId: logContext.getStore()?.requestId }
    }))))
    const response = await h3.toWebHandler(app)(new Request('http://local/api/item/private-id?token=hidden', { headers: { 'x-request-id': 'forged' } }))
    const id = response.headers.get('x-request-id')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await response.json()).toEqual({ requestId: id })
    expect(captured).toHaveBeenCalledTimes(1)
    expect(captured).toHaveBeenCalledWith('info', 'request.completed', expect.objectContaining({ requestId: id, route: '/api/item/:id', statusCode: 200 }))
    expect(JSON.stringify(captured.mock.calls)).not.toMatch(/hidden|private-id|forged/)
  })

  it('logs middleware failures once and records their real status and response ID', async () => {
    const app = h3.createApp({
      onRequest: event => { beginRequest(event); throw h3.createError({ statusCode: 401 }) },
      onError: (error, event) => {
        h3.setResponseStatus(event, 401)
        recordRequestError(event, error, 401)
        recordRequestError(event, error, 401)
        return apiErrorHandler(error, event)
      },
      onAfterResponse: finishRequest,
    })
    const response = await h3.toWebHandler(app)(new Request('http://local/api/private?token=hidden'))
    expect(response.status).toBe(401)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(captured.mock.calls.filter(x => x[1] === 'request.failed')).toHaveLength(1)
    expect(captured.mock.calls.filter(x => x[1] === 'request.completed')).toHaveLength(1)
  })
})
