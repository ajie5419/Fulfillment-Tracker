import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import apiErrorHandler from '../../server/api-error'
import { defineApiHandler, defineFlowHandler, defineFileHandler } from '../../server/utils/api'
import { createApiFetch } from '../../app/utils/api-fetch'
import { ClientRequestError } from '../../app/utils/transport'
import { apiSuccess, unwrapApiResponse } from '../../shared/api-response'
import { FlowHttpError } from '../../server/services/flow/errors'
import { useApiFetch, useApiRequestFetch } from '../../app/composables/useApiFetch'

const require = createRequire(import.meta.url)
const nuxtRequire = createRequire(require.resolve('nuxt/package.json'))
const h3 = nuxtRequire('h3') as typeof import('h3')
const { createFetch } = nuxtRequire('ofetch') as typeof import('ofetch')

beforeEach(() => {
  vi.stubGlobal('defineEventHandler', h3.defineEventHandler)
  vi.stubGlobal('createError', h3.createError)
  vi.stubGlobal('requireUser', () => ({ qmsUserId: 'test', name: 'Test' }))
  vi.stubGlobal('assertCanSee', async () => {})
})
afterEach(() => vi.unstubAllGlobals())

function appFetch(handler: ReturnType<typeof h3.defineEventHandler>, middleware?: ReturnType<typeof h3.defineEventHandler>) {
  const app = h3.createApp({ onError: apiErrorHandler })
  if (middleware) app.use(middleware)
  app.use(h3.createRouter().use('/api/example', handler))
  const web = h3.toWebHandler(app)
  return (path = '/api/example', options?: RequestInit) => web(new Request(`http://test.local${path}`, options))
}

describe('JSON wire contract through real H3 serialization', () => {
  it.each([{ rows: [], total: 0, page: 1, pageSize: 20 }, [], null, false, 0, 'text'])('wraps %j exactly once', async value => {
    const response = await appFetch(defineApiHandler(() => value))()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(apiSuccess(value))
  })

  it('normalizes void and preserves HTTP 202 recovery information', async () => {
    expect(await (await appFetch(defineApiHandler(() => undefined))()).json()).toEqual(apiSuccess(null))
    const response = await appFetch(defineFlowHandler(async event => {
      h3.setResponseStatus(event, 202)
      return { recovery: { operationId: 'pending-1' } }
    }))()
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(apiSuccess({ recovery: { operationId: 'pending-1' } }))
  })

  it.each([[400, 'VALIDATION'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [405, 'METHOD_NOT_ALLOWED'], [413, 'PAYLOAD_TOO_LARGE'], [429, 'RATE_LIMITED'], [503, 'UNAVAILABLE']] as const)('maps HTTP %s without turning failures into 200', async (statusCode, code) => {
    const response = await appFetch(defineApiHandler(() => { throw h3.createError({ statusCode, message: 'denied' }) }))()
    expect(response.status).toBe(statusCode)
    expect(await response.json()).toEqual({ code, data: null, message: statusCode >= 500 ? '服务暂时不可用，请稍后重试' : 'denied' })
  })

  it('covers middleware rejection and missing routes before a business handler runs', async () => {
    const business = vi.fn(() => 'never')
    const response = await appFetch(defineApiHandler(business), h3.defineEventHandler(() => {
      throw h3.createError({ statusCode: 401, message: '未登录' })
    }))()
    expect(business).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', data: null, message: '未登录' })
    const missing = await appFetch(defineApiHandler(business))('/api/missing')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND', data: null })
  })

  it('preserves safe conflict details and removes stack/database details from unexpected failures', async () => {
    const conflict = await appFetch(defineFlowHandler(async () => {
      throw new FlowHttpError('等待恢复', 409, 'CONFLICT', { operationId: 'pending-1' })
    }))()
    const body = await conflict.json()
    expect(body).toEqual({ code: 'CONFLICT', data: { operationId: 'pending-1' }, message: '等待恢复' })
    expect(new ClientRequestError({ status: 409, data: body })).toMatchObject({ statusCode: 409, code: 'CONFLICT', message: '等待恢复' })
    const unexpected = await appFetch(defineApiHandler(() => { throw new Error('private database diagnostic') }))()
    expect(unexpected.status).toBe(500)
    expect(await unexpected.json()).toEqual({ code: 'INTERNAL', data: null, message: '服务暂时不可用，请稍后重试' })
  })

  it('does not wrap file bytes or change download headers', async () => {
    const bytes = Buffer.from([0, 1, 255, 3])
    const response = await appFetch(defineFileHandler(async event => {
      h3.setResponseHeader(event, 'content-type', 'application/octet-stream')
      h3.setResponseHeader(event, 'content-disposition', 'attachment; filename="test.bin"')
      return bytes
    }))()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-disposition')).toContain('test.bin')
  })
})

describe('client decoding', () => {
  it('keeps SSR fetch instances separate and forwards Nuxt query/default/cancellation options', async () => {
    const first = vi.fn().mockResolvedValue(apiSuccess({ user: 'first' }))
    const second = vi.fn().mockResolvedValue(apiSuccess({ user: 'second' }))
    vi.stubGlobal('useRequestFetch', vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValue(first))
    const a = useApiRequestFetch(), b = useApiRequestFetch()
    expect(await a('/api/me')).toEqual({ user: 'first' })
    expect(await b('/api/me')).toEqual({ user: 'second' })
    const state = { data: { value: undefined }, error: { value: undefined } }
    const nuxtFetch = vi.fn().mockReturnValue(state)
    vi.stubGlobal('useFetch', nuxtFetch)
    const query = { page: 2 }, signal = new AbortController().signal
    const options = { query, signal, immediate: false, watch: false as const, default: () => [] }
    expect(useApiFetch('/api/work-orders', options)).toBe(state)
    const forwarded = nuxtFetch.mock.calls[0]![1]
    expect(forwarded.query).toBe(query)
    expect(forwarded.signal).toBe(signal)
    expect(forwarded.default).toBe(options.default)
    expect(forwarded.immediate).toBe(false)
    expect(forwarded.watch).toBe(false)
    expect(await forwarded.$fetch('/api/me')).toEqual({ user: 'first' })
  })
  it('decodes a real fetch response and preserves cancellation, headers and multipart input', async () => {
    const execute = appFetch(defineApiHandler(event => ({ cookie: h3.getHeader(event, 'cookie') })))
    const raw = createFetch({ fetch: (request, init) => execute(String(request), init as RequestInit) })
    const client = createApiFetch(raw)
    expect(await client('/api/example', { headers: { cookie: 'test=session' } })).toEqual({ cookie: 'test=session' })
    const signal = new AbortController().signal
    const body = new FormData()
    body.append('file', new Blob(['test']), 'test.txt')
    const mock = vi.fn().mockResolvedValue(apiSuccess([]))
    await createApiFetch(mock)('/api/uploads', { method: 'POST', signal, body })
    expect(mock).toHaveBeenCalledWith('/api/uploads', { method: 'POST', signal, body })
    const abort = new DOMException('aborted', 'AbortError')
    mock.mockRejectedValueOnce(abort)
    await expect(createApiFetch(mock)('/api/example')).rejects.toBe(abort)
  })

  it.each([{}, { rows: [] }, { code: 0, message: 'ok' }, { code: 'CONFLICT', data: null, message: 'error' }])('rejects malformed or failed success bodies: %j', value => {
    expect(() => unwrapApiResponse(value)).toThrow('接口响应格式不正确')
  })
})
