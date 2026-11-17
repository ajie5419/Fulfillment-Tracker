import { afterEach, expect, it, vi } from 'vitest'

const resolveSession = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../server/services/auth/session', () => ({ SESSION_COOKIE: 'ft_session', resolveSession }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('protects retired preview routes, similarly named pages and APIs', async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getCookie', () => undefined)
  vi.stubGlobal('prisma', {})
  vi.stubGlobal('createError', (error: { statusCode: number }) => Object.assign(new Error('unauthorized'), error))
  const redirect = vi.fn()
  vi.stubGlobal('sendRedirect', redirect)
  const { default: handler } = await import('../../server/middleware/auth')
  for (const path of ['/brick-demo', '/brick-demo/', '/brick-demo?preview=1', '/brick-demo-private']) {
    await handler({ path } as never)
    expect(redirect).toHaveBeenLastCalledWith(expect.anything(), `/auth/login?redirect=${encodeURIComponent(path)}`, 302)
  }
  expect(resolveSession).toHaveBeenCalledTimes(4)
  await expect(handler({ path: '/api/reminders/new' } as never)).rejects.toMatchObject({ statusCode: 401 })
})
