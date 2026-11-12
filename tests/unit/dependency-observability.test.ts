import { expect, it, vi } from 'vitest'
import { observedFetch } from '../../server/observability/dependency'
import { monitoringReady } from '../../server/observability/health'
const log = vi.hoisted(() => vi.fn())
vi.mock('../../server/observability/logger', () => ({ logEvent: log }))
it('records rejected and failing HTTP dependencies without URLs, payloads, or changing responses', async () => {
  const response = new Response('private upstream body', { status: 503 })
  const fetcher = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
  const wrapped = observedFetch('qms.sync', fetcher)
  expect(await wrapped('https://private?token=secret')).toBe(response)
  await expect(wrapped('https://private?token=secret')).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(log).toHaveBeenCalledWith('error', 'dependency.http.failed', expect.objectContaining({ statusCode: 503 }))
  expect(log).toHaveBeenCalledWith('error', 'dependency.transport.failed', expect.objectContaining({ module: 'qms.sync' }), expect.any(Error))
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|token=secret/)
})
it('lets an independent monitor detect monitoring-stack failure, including connection errors', async () => {
  const fetcher = vi.fn(async () => new Response('ready'))
  expect(await monitoringReady(fetcher)).toBe(true)
  fetcher.mockRejectedValueOnce(new Error('collector unavailable'))
  expect(await monitoringReady(fetcher)).toBe(false)
  fetcher.mockResolvedValueOnce(new Response('not ready', { status: 503 }))
  expect(await monitoringReady(fetcher)).toBe(false)
})
