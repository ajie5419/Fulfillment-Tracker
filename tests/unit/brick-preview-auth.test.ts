import { afterEach, expect, it, vi } from 'vitest'

const resolveSession = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../server/services/auth/session', () => ({ SESSION_COOKIE: 'ft_session', resolveSession }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('allows only the anonymous preview route while protecting similarly named pages and APIs', async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getCookie', () => undefined)
  vi.stubGlobal('prisma', {})
  vi.stubGlobal('createError', (error: { statusCode: number }) => Object.assign(new Error('unauthorized'), error))
  const redirect = vi.fn()
  vi.stubGlobal('sendRedirect', redirect)
  const { default: handler } = await import('../../server/middleware/auth')
  for (const path of ['/brick-demo', '/brick-demo/', '/brick-demo?preview=1']) {
    await handler({ path } as never)
  }
  expect(resolveSession).not.toHaveBeenCalled()
  expect(redirect).not.toHaveBeenCalled()
  await handler({ path: '/brick-demo-private' } as never)
  expect(redirect).toHaveBeenCalledWith(expect.anything(), '/auth/login?redirect=%2Fbrick-demo-private', 302)
  await expect(handler({ path: '/api/reminders/new' } as never)).rejects.toMatchObject({ statusCode: 401 })
})
