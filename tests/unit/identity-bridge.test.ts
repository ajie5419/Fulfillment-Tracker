import { describe, expect, it, vi } from 'vitest'
import {
  IdentityBridgeError,
  buildAuthorizeUrl,
  exchangeCode,
  revokeCredential,
  verifyIdentity,
  type IdentityBridgeConfig,
} from '../../server/services/auth/identity-bridge'

const cfg: IdentityBridgeConfig = {
  apiBase: 'http://qms-backend:3000',
  authorizeUrl: 'http://10.0.0.1/#/identity/authorize',
  clientId: 'fulfillment',
  clientSecret: 's'.repeat(32),
  callbackUrl: 'https://10.0.0.1/auth/callback',
}

const CRED = 'c'.repeat(43)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const call = (fn: ReturnType<typeof vi.fn>, i = 0) => fn.mock.calls[i] as unknown as [string, RequestInit]

describe('buildAuthorizeUrl', () => {
  it('QMS 参数名，参数拼在 hash 路由之后', () => {
    const url = buildAuthorizeUrl(cfg, { state: 'st', codeChallenge: 'ch' })
    expect(url.startsWith('http://10.0.0.1/#/identity/authorize?')).toBe(true)
    expect(Object.fromEntries(new URLSearchParams(url.split('?')[1]))).toEqual({
      clientId: 'fulfillment',
      redirectUri: 'https://10.0.0.1/auth/callback',
      state: 'st',
      challenge: 'ch',
      method: 'S256',
    })
  })

  it('forceLogin 时带 prompt=login（退出后要求 QMS 重新输入账号密码），默认不带', () => {
    const q = (u: string) => new URLSearchParams(u.split('?')[1])
    expect(q(buildAuthorizeUrl(cfg, { state: 'st', codeChallenge: 'ch', forceLogin: true })).get('prompt')).toBe('login')
    expect(q(buildAuthorizeUrl(cfg, { state: 'st', codeChallenge: 'ch' })).has('prompt')).toBe(false)
  })
})

describe('exchangeCode', () => {
  it('POST /exchange，客户端认证头，body 只有 redirectUri/code/verifier（QMS 为 strict 校验）', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { credential: CRED, expiresAt: '2026-10-16T10:00:00Z' } }))
    await expect(exchangeCode(cfg, { code: 'k', codeVerifier: 'v' }, fetchImpl)).resolves.toBe(CRED)
    const [url, init] = call(fetchImpl)
    expect(url).toBe('http://qms-backend:3000/api/identity-bridge/exchange')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-Identity-Client-Id': 'fulfillment', 'X-Identity-Client-Secret': 's'.repeat(32) })
    expect(JSON.parse(init.body as string)).toEqual({ redirectUri: 'https://10.0.0.1/auth/callback', code: 'k', verifier: 'v' })
  })

  it('非 2xx 抛 IdentityBridgeError 并带阶段与状态码', async () => {
    const fetchImpl = vi.fn(async () => json({ code: -1, message: 'invalid' }, 401))
    const err = await exchangeCode(cfg, { code: 'k', codeVerifier: 'v' }, fetchImpl).catch((e) => e)
    expect(err).toBeInstanceOf(IdentityBridgeError)
    expect(err).toMatchObject({ stage: 'exchange', status: 401 })
  })

  it('响应不是 { code: 0, data: { credential } } 视为失败', async () => {
    const fetchImpl = vi.fn(async () => json({ credential: CRED }))
    await expect(exchangeCode(cfg, { code: 'k', codeVerifier: 'v' }, fetchImpl)).rejects.toBeInstanceOf(IdentityBridgeError)
  })
})

describe('verifyIdentity', () => {
  it('POST /identity，客户端认证头 + Bearer 凭证，返回 {id, name, active}', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { id: 'u1', name: '张三', active: true } }))
    await expect(verifyIdentity(cfg, CRED, fetchImpl)).resolves.toEqual({ id: 'u1', name: '张三', active: true })
    const [url, init] = call(fetchImpl)
    expect(url).toBe('http://qms-backend:3000/api/identity-bridge/identity')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${CRED}`, 'X-Identity-Client-Id': 'fulfillment' })
  })

  it('账号停用时 QMS 返回 401，带上 stage=identity 供回调区分', async () => {
    const fetchImpl = vi.fn(async () => json({ code: -1 }, 401))
    await expect(verifyIdentity(cfg, CRED, fetchImpl)).rejects.toMatchObject({ stage: 'identity', status: 401 })
  })

  it('缺字段视为失败；网络错误包装为 IdentityBridgeError', async () => {
    await expect(verifyIdentity(cfg, CRED, vi.fn(async () => json({ code: 0, data: { id: 'u1' } })))).rejects.toBeInstanceOf(
      IdentityBridgeError,
    )
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(verifyIdentity(cfg, CRED, down)).rejects.toMatchObject({ stage: 'identity' })
  })
})

describe('revokeCredential', () => {
  it('POST /revoke 带凭证；失败不抛错', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { revoked: true } }))
    await revokeCredential(cfg, CRED, fetchImpl)
    expect(call(fetchImpl)[0]).toBe('http://qms-backend:3000/api/identity-bridge/revoke')
    await expect(
      revokeCredential(cfg, CRED, vi.fn(async () => {
        throw new Error('down')
      })),
    ).resolves.toBeUndefined()
  })
})
