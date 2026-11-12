// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createErrorReporter, reportRequestFailure } from '../../app/utils/error-reporter'
import { CLIENT_REPORT_LIMIT, CLIENT_REPORT_WINDOW_MS } from '../../shared/telemetry'

afterEach(() => vi.unstubAllGlobals())
it('redacts diagnostics, deduplicates repeated errors, bounds traffic and resets the time window', async () => {
  let now = 0
  const send = vi.fn(async () => {})
  const report = createErrorReporter(send, () => '/work-orders/:id', () => now)
  const error = new TypeError('private credential and customer data')
  report('vue', error); report('javascript', error)
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(send.mock.calls)).not.toContain('private credential')
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'vue', errorType: 'TypeError', route: '/work-orders/:id' }))
  for (let i = 0; i < 40; i++) report('promise', new Error(String(i)))
  expect(send).toHaveBeenCalledTimes(CLIENT_REPORT_LIMIT)
  now += CLIENT_REPORT_WINDOW_MS
  report('vue', error)
  expect(send).toHaveBeenCalledTimes(CLIENT_REPORT_LIMIT + 1)
})

it('does not retry or propagate a failed telemetry submission, and ignores cancellations', async () => {
  const send = vi.fn(async () => { throw new Error('offline') })
  const report = createErrorReporter(send, () => '/')
  report('request', new DOMException('cancelled', 'AbortError'))
  expect(send).not.toHaveBeenCalled()
  report('javascript', new Error('failure'))
  await Promise.resolve(); await Promise.resolve()
  expect(send).toHaveBeenCalledTimes(1)
})

it('registers Vue, Nuxt, JavaScript, rejection, resource and handled request failures', async () => {
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('defineNuxtPlugin', (p: unknown) => p)
  vi.stubGlobal('useRouter', () => ({ currentRoute: { value: { matched: [{ path: '/orders/:id' }] } } }))
  const callbacks = new Map<string, (error: unknown) => void>()
  const { default: plugin } = await import('../../app/plugins/observability.client')
  await plugin({ hook: (name: string, run: (error: unknown) => void) => { callbacks.set(name, run); return () => {} } } as never)
  callbacks.get('vue:error')!(new TypeError('vue failure'))
  callbacks.get('app:error')!(new Error('app failure'))
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('javascript failure') }))
  const rejection = Object.assign(new Event('unhandledrejection'), { reason: new Error('promise failure') })
  window.dispatchEvent(rejection)
  const image = document.createElement('img'); document.body.append(image); image.dispatchEvent(new Event('error'))
  reportRequestFailure({ response: new Response('{}', { status: 503, headers: { 'x-request-id': '77897558-bb4c-4f9e-84d6-0938c79bcb04' } }), name: 'NetworkError' })
  const reports = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))
  expect(reports.map(r => r.kind)).toEqual(['vue', 'app', 'javascript', 'promise', 'resource', 'request'])
  expect(reports.at(-1)).toMatchObject({ requestId: '77897558-bb4c-4f9e-84d6-0938c79bcb04', statusCode: 503 })
  expect(JSON.stringify(reports)).not.toContain('javascript failure')
})
