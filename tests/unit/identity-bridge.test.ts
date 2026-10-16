import { describe, expect, it, vi } from 'vitest'
import {
  IdentityBridgeError,
  buildAuthorizeUrl,
  exchangeCode,
  verifyIdentity,
  type IdentityBridgeConfig,
} from '../../server/services/auth/identity-bridge'

const cfg: IdentityBridgeConfig = {
  apiBase: 'http://qms-backend:3000',
  authorizeUrl: 'http://qms.local/#/auth/identity-authorize',
  tokenPath: '/api/identity-bridge/token',
  verifyPath: '/api/identity-bridge/verify',
  clientId: 'fulfillment',
  clientSecret: 's3cret',
  callbackUrl: 'https://localhost:3100/auth/callback',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('buildAuthorizeUrl', () => {
  it('参数拼在 hash 路由之后，并带 S256 challenge', () => {
    const url = buildAuthorizeUrl(cfg, { state: 'st', codeChallenge: 'ch' })
    expect(url.startsWith('http://qms.local/#/auth/identity-authorize?')).toBe(true)
    const q = new URLSearchParams(url.split('?')[1])
    expect(Object.fromEntries(q)).toEqual({
      response_type: 'code',
      client_id: 'fulfillment',
      redirect_uri: 'https://localhost:3100/auth/callback',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    })
  })
})

describe('exchangeCode / verifyIdentity', () => {
  it('带客户端认证头换凭证，并兼容 { data } 包装', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { identityToken: 'tok' } }))
    await expect(exchangeCode(cfg, { code: 'c', codeVerifier: 'v' }, fetchImpl)).resolves.toBe('tok')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://qms-backend:3000/api/identity-bridge/token')
    expect(init.headers).toMatchObject({ 'X-Identity-Client-Id': 'fulfillment', 'X-Identity-Client-Secret': 's3cret' })
    expect(JSON.parse(init.body as string)).toMatchObject({ code: 'c', code_verifier: 'v' })
  })

  it('身份核查返回 {id, name, active}', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'u1', name: '张三', active: true }))
    await expect(verifyIdentity(cfg, 'tok', fetchImpl)).resolves.toEqual({ id: 'u1', name: '张三', active: true })
  })

  it('非 2xx 抛 IdentityBridgeError 并带阶段与状态码', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'bad code' }, 400))
    const err = await exchangeCode(cfg, { code: 'c', codeVerifier: 'v' }, fetchImpl).catch((e) => e)
    expect(err).toBeInstanceOf(IdentityBridgeError)
    expect(err).toMatchObject({ stage: 'exchange', status: 400 })
  })

  it('响应缺字段视为失败，不放行', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'u1' }))
    await expect(verifyIdentity(cfg, 'tok', fetchImpl)).rejects.toBeInstanceOf(IdentityBridgeError)
  })

  it('网络错误包装为 IdentityBridgeError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(verifyIdentity(cfg, 'tok', fetchImpl)).rejects.toMatchObject({ stage: 'verify' })
  })
})
