#!/usr/bin/env node
/**
 * 本地模拟 QMS 身份桥，供集成测试和"QMS 还没在本地跑起来"时演示登录。
 * 行为按 QMS apps/backend/modules/identity-bridge（2026-10-15 版）实现：
 * 参数名与格式校验（strict body、43 位 code/credential/challenge、state 43–128 位）、
 * 客户端认证头、{ code: 0, data } 包装、停用账号核查返回 401、授权码一次性。
 * 它只是模拟：登录走通的最终依据是对接真实 QMS 本地环境。
 *
 *   node scripts/mock-identity-bridge.mjs            # 监听 4100
 *   .env：NUXT_QMS_API_BASE=http://localhost:4100  NUXT_QMS_AUTHORIZE_URL=http://localhost:4100/identity/authorize
 *
 * 授权页不弹登录框，直接以 mock_user（默认 u-001）身份同意。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/**
 * @param {{ port?: number, clientId?: string, clientSecret?: string, callback?: string,
 *   users?: Record<string, { name: string, active: boolean }>, defaultUserId?: string }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startMockIdentityBridge({
  port = 0,
  clientId = 'fulfillment',
  clientSecret = 'local-dev-secret-local-dev-secret-0',
  callback = 'https://localhost:3100/auth/callback',
  users = { 'u-001': { name: '测试外协专员', active: true } },
  defaultUserId = 'u-001',
} = {}) {
  const OPAQUE = /^[\w-]{43}$/
  const token = () => randomBytes(32).toString('base64url')
  const codes = new Map() // code -> { challenge, userId, expiresAt }
  const credentials = new Map() // credential -> { userId, revoked }

  const ok = (res, data) => send(res, 200, { code: 0, data, error: null, message: 'ok' })
  const reject = (res, status = 401) => send(res, status, { code: -1, data: null, message: 'Identity authorization is invalid or expired' })
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
          resolve(null)
        }
      })
    })
  const clientOk = (req) =>
    req.headers['x-identity-client-id'] === clientId && req.headers['x-identity-client-secret'] === clientSecret
  const bearer = (req) => /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
  const activeUser = (id) => (users[id]?.active ? { id, name: users[id].name, active: true } : null)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    // 相当于 QMS 授权页 + POST /api/identity-bridge/authorize（已登录用户点"继续"）
    if (req.method === 'GET' && url.pathname === '/identity/authorize') {
      const q = Object.fromEntries(url.searchParams)
      const userId = q.mock_user ?? defaultUserId
      if (
        q.clientId !== clientId ||
        q.redirectUri !== callback ||
        q.method !== 'S256' ||
        !OPAQUE.test(q.challenge ?? '') ||
        !/^[\w-]{43,128}$/.test(q.state ?? '')
      ) {
        return reject(res, 400)
      }
      if (!activeUser(userId)) return reject(res) // QMS 授权时即直查 ACTIVE 且未删除
      const code = token()
      codes.set(code, { challenge: q.challenge, userId, expiresAt: Date.now() + 60_000 })
      const back = new URL(callback)
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.state)
      return send(res, 302, undefined, { Location: back.href })
    }
    if (req.method !== 'POST') return send(res, 404, { message: 'not found' })
    if (!clientOk(req)) return reject(res)

    if (url.pathname === '/api/identity-bridge/exchange') {
      const body = await readJson(req)
      const keys = body && typeof body === 'object' ? Object.keys(body).sort().join(',') : ''
      if (keys !== 'code,redirectUri,verifier' || !OPAQUE.test(body.code) || !/^[\w.~-]{43,128}$/.test(body.verifier)) {
        return reject(res, 400)
      }
      const entry = codes.get(body.code)
      const challenge = createHash('sha256').update(body.verifier).digest('base64url')
      if (!entry || entry.expiresAt < Date.now() || body.redirectUri !== callback || challenge !== entry.challenge) {
        return reject(res)
      }
      codes.delete(body.code) // 一次性
      if (!activeUser(entry.userId)) return reject(res)
      const credential = token()
      credentials.set(credential, { userId: entry.userId, revoked: false })
      return ok(res, { credential, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (url.pathname === '/api/identity-bridge/identity') {
      const record = credentials.get(bearer(req) ?? '')
      const user = record && !record.revoked ? activeUser(record.userId) : null
      return user ? ok(res, user) : reject(res)
    }
    if (url.pathname === '/api/identity-bridge/revoke') {
      const cred = bearer(req)
      if (!cred) return reject(res)
      const record = credentials.get(cred)
      if (record) record.revoked = true
      return ok(res, { revoked: true })
    }
    send(res, 404, { message: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address()
      resolve({ url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startMockIdentityBridge({ port: Number(process.env.MOCK_PORT ?? 4100) })
  console.log(`mock identity bridge listening on ${url}`)
}
