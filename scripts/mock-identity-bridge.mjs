#!/usr/bin/env node
/**
 * 本地模拟 QMS 身份桥（授权码 + PKCE），供集成测试和"QMS 还没在本地跑起来"时演示登录。
 * 它实现的是 server/services/auth/identity-bridge.ts 假定的接口，不代表 QMS 真实实现。
 *
 *   node scripts/mock-identity-bridge.mjs            # 监听 4100
 *   NUXT_QMS_API_BASE=http://localhost:4100 NUXT_QMS_AUTHORIZE_URL=http://localhost:4100/authorize pnpm dev
 *
 * 授权页不弹登录框，直接以 MOCK_USER_ID / MOCK_USER_NAME 身份同意。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/**
 * @param {{ port?: number, clientId?: string, clientSecret?: string,
 *   users?: Record<string, { name: string, active: boolean }>, defaultUserId?: string }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startMockIdentityBridge({
  port = 0,
  clientId = 'fulfillment',
  clientSecret = 'local-dev-secret',
  users = { 'u-001': { name: '测试外协专员', active: true } },
  defaultUserId = 'u-001',
} = {}) {
  const codes = new Map() // code -> { challenge, redirectUri, userId }
  const tokens = new Map() // identityToken -> userId

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
    })
  const clientOk = (req) =>
    req.headers['x-identity-client-id'] === clientId && req.headers['x-identity-client-secret'] === clientSecret

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams
      const userId = q.get('mock_user') ?? defaultUserId
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return send(res, 400, { message: 'invalid authorize request' })
      }
      const redirectUri = q.get('redirect_uri')
      if (!redirectUri?.startsWith('https://')) return send(res, 400, { message: 'callback must be https' })
      const code = randomBytes(16).toString('base64url')
      codes.set(code, { challenge: q.get('code_challenge'), redirectUri, userId })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state') ?? '')
      return send(res, 302, undefined, { Location: back.toString() })
    }
    if (req.method === 'POST' && url.pathname === '/api/identity-bridge/token') {
      if (!clientOk(req)) return send(res, 401, { message: 'client auth failed' })
      const body = await readJson(req)
      const entry = codes.get(body.code)
      codes.delete(body.code) // 一次性
      if (!entry) return send(res, 400, { message: 'invalid code' })
      const challenge = createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url')
      if (challenge !== entry.challenge || body.redirect_uri !== entry.redirectUri) {
        return send(res, 400, { message: 'pkce or redirect mismatch' })
      }
      const identityToken = randomBytes(24).toString('base64url')
      tokens.set(identityToken, entry.userId)
      return send(res, 200, { code: 0, data: { identityToken } })
    }
    if (req.method === 'POST' && url.pathname === '/api/identity-bridge/verify') {
      if (!clientOk(req)) return send(res, 401, { message: 'client auth failed' })
      const body = await readJson(req)
      const userId = tokens.get(body.identityToken)
      if (!userId || !users[userId]) return send(res, 401, { message: 'invalid identity token' })
      return send(res, 200, { code: 0, data: { id: userId, ...users[userId] } })
    }
    send(res, 404, { message: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address()
      resolve({ url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startMockIdentityBridge({ port: Number(process.env.MOCK_PORT ?? 4100) })
  console.log(`mock identity bridge listening on ${url}`)
}
