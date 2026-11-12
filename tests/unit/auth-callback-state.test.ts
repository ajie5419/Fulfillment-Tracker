import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { consumeLogin } = vi.hoisted(() => ({ consumeLogin: vi.fn() }))
vi.mock('../../server/observability/request', () => ({ withRequestContext: (_event: unknown, run: () => unknown) => run() }))
vi.mock('../../server/services/auth/login-attempt', () => ({
  LOGIN_STATE_COOKIE: 'ft_login_state',
  consumeLogin,
}))
vi.mock('../../server/services/auth/identity-bridge', () => ({
  IdentityBridgeError: class extends Error {},
  exchangeCode: vi.fn(),
  revokeCredential: vi.fn(),
  verifyIdentity: vi.fn(),
}))
vi.mock('../../server/services/auth/session', () => ({
  SessionAccountUnavailable: class extends Error {},
  createSession: vi.fn(),
}))

const currentState = 'current-browser-attempt'
const deleteCookie = vi.fn()
let query: Record<string, unknown>
let cookie: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  cookie = currentState
  query = { code: 'synthetic-invalid-code', state: currentState }
  consumeLogin.mockResolvedValue(null)
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('getCookie', () => cookie)
  vi.stubGlobal('deleteCookie', deleteCookie)
  vi.stubGlobal('createError', (details: object) => Object.assign(new Error(), details))
  vi.stubGlobal('prisma', {})
})
afterEach(() => vi.unstubAllGlobals())

async function callback() {
  const { default: handler } = await import('../../server/routes/auth/callback.get')
  return handler({} as Parameters<typeof handler>[0])
}

describe('callback only clears the matching browser attempt', () => {
  it.each([
    { code: 'synthetic-invalid-code', state: 'older-tab-attempt' },
    { code: 'synthetic-invalid-code', state: 'same-length-wrong-state' },
    {},
    { code: ['invalid'], state: currentState },
    { error: 'access_denied', state: 'older-tab-attempt' },
  ])('rejects invalid callbacks without clearing the pending cookie: %j', async (invalid) => {
    query = invalid
    await expect(callback()).rejects.toMatchObject({ statusCode: 400 })
    expect(deleteCookie).not.toHaveBeenCalled()
    expect(consumeLogin).not.toHaveBeenCalled()
  })

  it('rejects a missing browser cookie without consuming an attempt', async () => {
    cookie = undefined
    await expect(callback()).rejects.toMatchObject({ statusCode: 400 })
    expect(deleteCookie).not.toHaveBeenCalled()
    expect(consumeLogin).not.toHaveBeenCalled()
  })

  it('clears a matching cookie and still rejects expired or consumed attempts', async () => {
    await expect(callback()).rejects.toMatchObject({ statusCode: 400 })
    expect(deleteCookie).toHaveBeenCalledWith({}, 'ft_login_state', { path: '/auth/' })
    expect(consumeLogin).toHaveBeenCalledWith({}, currentState)
  })

  it('an older callback does not invalidate the current desktop or mobile attempt', async () => {
    query.state = 'older-tab-attempt'
    await expect(callback()).rejects.toMatchObject({ statusCode: 400 })
    expect(deleteCookie).not.toHaveBeenCalled()
    query.state = currentState
    await expect(callback()).rejects.toMatchObject({ statusCode: 400 })
    expect(consumeLogin).toHaveBeenCalledTimes(1)
    expect(deleteCookie).toHaveBeenCalledTimes(1)
  })
})
