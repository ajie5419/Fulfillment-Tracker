import { createRequire } from 'node:module'
import { beforeEach, expect, it, vi } from 'vitest'
import { acceptClientReport, createReportLimiter } from '../../server/observability/client-report'
const logs = vi.hoisted(() => vi.fn())
vi.mock('../../server/observability/logger', () => ({ logEvent: logs }))
const require = createRequire(import.meta.url)
const h3 = createRequire(require.resolve('nuxt/package.json'))('h3') as typeof import('h3')
beforeEach(() => logs.mockClear())
const body = { kind: 'javascript', errorType: 'TypeError', fingerprint: '1234abcd', route: '/orders/:id' }
async function send(data: unknown, origin = 'https://local') {
  const app = h3.createApp()
  app.use(h3.defineEventHandler(acceptClientReport))
  return h3.toWebHandler(app)(new Request('https://local/api/telemetry/client', { method: 'POST', headers: { origin, host: 'local', 'content-type': 'application/json' }, body: JSON.stringify(data) }))
}
it('accepts bounded reports without claiming client-supplied IDs as server identity', async () => {
  expect((await send(body)).status).toBe(200)
  expect(logs).toHaveBeenCalledWith('warn', 'client.reported', expect.objectContaining({ clientFingerprint: '1234abcd' }))
  expect(logs.mock.calls[0]![2]).not.toHaveProperty('actorId')
})
it('rejects cross-origin, oversized, unknown fields and forged identities', async () => {
  expect((await send(body, 'https://attacker')).status).toBe(403)
  expect((await send({ ...body, message: 'private payload' })).status).toBe(400)
  expect((await send({ ...body, actorId: 'admin' })).status).toBe(400)
  expect((await send({ ...body, route: 'x'.repeat(5000) })).status).toBe(413)
  expect(logs).not.toHaveBeenCalled()
})
it('bounds per-peer and aggregate traffic, then resets the window', () => {
  let now = 0
  const admit = createReportLimiter(() => now)
  for (let i = 0; i < 20; i++) expect(admit('same')).toBe(true)
  expect(admit('same')).toBe(false)
  for (let i = 0; i < 100; i++) expect(admit(String(i))).toBe(true)
  expect(admit('new')).toBe(false)
  now = 60_000
  expect(admit('same')).toBe(true)
})
