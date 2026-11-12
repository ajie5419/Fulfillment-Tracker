import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../server/observability/request', () => ({ withRequestContext: (_event: unknown, run: () => unknown) => run() }))

const mocks = vi.hoisted(() => ({
  startLogin: vi.fn(), consumeLogin: vi.fn(), createSession: vi.fn(), resolveSession: vi.fn(), destroySession: vi.fn(),
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: {} }))
vi.mock('../../server/services/auth/identity-bridge', () => ({
  IdentityBridgeError: class extends Error {},
  buildAuthorizeUrl: () => '/authorize',
  exchangeCode: async () => 'synthetic-credential',
  verifyIdentity: async () => ({ id: 'synthetic-user', name: 'Test', active: true }),
  revokeCredential: async () => {},
}))

const jar = new Map<string, string>()
const writes = vi.fn()
let query: Record<string, string> = {}
const event = () => ({ path: '/api/me', context: {} }) as H3Event

beforeEach(() => {
  vi.clearAllMocks()
  jar.clear()
  query = {}
  let attempt = 0
  let session = 0
  mocks.startLogin.mockImplementation(async () => ({ state: `state-${++attempt}`, codeChallenge: 'synthetic-challenge' }))
  mocks.consumeLogin.mockResolvedValue({ codeVerifier: 'synthetic-verifier', redirect: '/' })
  mocks.createSession.mockImplementation(async () => ({ token: `token-${++session}`, expiresAt: new Date('2030-01-01') }))
  mocks.resolveSession.mockImplementation(async (_db, token) => token ? ({
    session: { qmsUserId: 'synthetic-user', userName: 'Test' }, renewedExpiresAt: new Date('2030-02-01'),
  }) : null)
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('getCookie', (_event: unknown, name: string) => jar.get(name))
  vi.stubGlobal('setCookie', (_event: unknown, name: string, value: string, options: object) => {
    jar.set(name, value)
    writes(name, value, options)
  })
  vi.stubGlobal('deleteCookie', (_event: unknown, name: string) => jar.delete(name))
  vi.stubGlobal('createError', (details: object) => Object.assign(new Error(), details))
  vi.stubGlobal('sendRedirect', () => undefined)
  vi.stubGlobal('identityConfig', () => ({}))
  vi.stubGlobal('prisma', {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

async function loadMode(sandbox: string | undefined) {
  vi.stubEnv('NUXT_SANDBOX', sandbox)
  vi.doUnmock('../../server/services/auth/login-attempt')
  vi.doUnmock('../../server/services/auth/session')
  vi.resetModules()
  const names = await import('../../server/services/auth/cookie-names')
  const attempts = await import('../../server/services/auth/login-attempt')
  const sessions = await import('../../server/services/auth/session')
  vi.doMock('../../server/services/auth/login-attempt', () => ({
    ...attempts, startLogin: mocks.startLogin, consumeLogin: mocks.consumeLogin,
  }))
  vi.doMock('../../server/services/auth/session', () => ({
    ...sessions, createSession: mocks.createSession, resolveSession: mocks.resolveSession, destroySession: mocks.destroySession,
  }))
  const { setSessionCookie } = await import('../../server/utils/auth')
  const { default: login } = await import('../../server/routes/auth/login.get')
  const { default: callback } = await import('../../server/routes/auth/callback.get')
  const { default: middleware } = await import('../../server/middleware/auth')
  const { default: logoutGet } = await import('../../server/routes/auth/logout.get')
  const { default: logoutPost } = await import('../../server/routes/auth/logout.post')
  return { names: names.AUTH_COOKIES, setSessionCookie, login, callback, middleware, logoutGet, logoutPost }
}

describe('sandbox authentication cookie isolation on the same host', () => {
  it.each([undefined, '0', 'true'])('preserves existing production/demo cookie names for NUXT_SANDBOX=%s', async (value) => {
    const mode = await loadMode(value)
    expect(mode.names).toEqual({ session: 'ft_session', loginState: 'ft_login_state' })
  })

  it.each(['logoutGet', 'logoutPost'] as const)('keeps concurrent login, callback, renewal and %s independent', async (logout) => {
    const normal = await loadMode(undefined)
    const sandbox = await loadMode('1')
    expect(sandbox.names).toEqual({ session: 'ft_sandbox_session', loginState: 'ft_sandbox_login_state' })

    await normal.login(event())
    const normalState = jar.get(normal.names.loginState)
    await sandbox.login(event())
    const sandboxState = jar.get(sandbox.names.loginState)
    expect(jar.size).toBe(2)
    expect(normalState).not.toEqual(sandboxState)

    // A callback from one mode cannot consume the other mode's browser attempt.
    query = { code: 'synthetic-code', state: String(normalState) }
    await expect(sandbox.callback(event())).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.consumeLogin).not.toHaveBeenCalled()
    expect(jar.get(sandbox.names.loginState)).toBe(sandboxState)

    vi.stubGlobal('setSessionCookie', normal.setSessionCookie)
    await normal.callback(event())
    expect(jar.has(normal.names.loginState)).toBe(false)
    expect(jar.get(sandbox.names.loginState)).toBe(sandboxState)
    const normalToken = jar.get(normal.names.session)

    query = { code: 'synthetic-code', state: String(sandboxState) }
    vi.stubGlobal('setSessionCookie', sandbox.setSessionCookie)
    await sandbox.callback(event())
    expect(jar.has(sandbox.names.loginState)).toBe(false)
    expect(jar.get(normal.names.session)).toBe(normalToken)
    const sandboxToken = jar.get(sandbox.names.session)
    expect(normalToken).not.toEqual(sandboxToken)
    expect(jar.size).toBe(2)

    for (const mode of [normal, sandbox]) {
      vi.stubGlobal('setSessionCookie', mode.setSessionCookie)
      writes.mockClear()
      await mode.middleware(event())
      expect(writes).toHaveBeenCalledExactlyOnceWith(mode.names.session, jar.get(mode.names.session), {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: new Date('2030-02-01'),
      })
    }
    await sandbox[logout](event())
    expect(mocks.destroySession).toHaveBeenLastCalledWith({}, sandboxToken)
    expect(jar.get(normal.names.session)).toBe(normalToken)
    expect(jar.has(sandbox.names.session)).toBe(false)
    await normal[logout](event())
    expect(mocks.destroySession).toHaveBeenLastCalledWith({}, normalToken)
    expect(jar.size).toBe(0)
  })

  it('clears an invalid sandbox session without removing the normal session', async () => {
    const normal = await loadMode(undefined)
    const sandbox = await loadMode('1')
    jar.set(normal.names.session, 'normal-session')
    jar.set(sandbox.names.session, 'expired-sandbox-session')
    mocks.resolveSession.mockResolvedValue(null)
    await expect(sandbox.middleware(event())).rejects.toMatchObject({ statusCode: 401 })
    expect(jar.get(normal.names.session)).toBe('normal-session')
    expect(jar.has(sandbox.names.session)).toBe(false)
  })
})
