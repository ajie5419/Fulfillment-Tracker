/**
 * 登录走通（R1 验收，A1 登录部分）：真实构建产物 + 真实 MySQL + 模拟身份桥。
 * 运行：pnpm build && TEST_DATABASE_URL=mysql://… pnpm test:integration
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockIdentityBridge } from '../../scripts/mock-identity-bridge.mjs'

const DB = process.env.TEST_DATABASE_URL
const SERVER_ENTRY = '.output/server/index.mjs'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

/** 只取 Set-Cookie 里的 name=value */
function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const i = pair!.indexOf('=')
    out[pair!.slice(0, i)] = pair!.slice(i + 1)
  }
  return out
}
const cookieHeader = (c: Record<string, string>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

describe.skipIf(!DB)('身份桥登录走通', () => {
  let app: ChildProcess
  let base: string
  let bridge: { url: string; close: () => Promise<void> }

  beforeAll(async () => {
    if (!existsSync(SERVER_ENTRY)) throw new Error('先运行 pnpm build')
    // 专用测试库：建表到最新迁移，再清空会话表
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    const db = new PrismaClient({ datasourceUrl: DB })
    await db.session.deleteMany()
    await db.loginAttempt.deleteMany()
    await db.$disconnect()
    bridge = await startMockIdentityBridge({
      users: { 'u-001': { name: '测试外协专员', active: true }, 'u-002': { name: '已停用', active: false } },
    })
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    app = spawn('node', [SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_URL: DB,
        NUXT_QMS_API_BASE: bridge.url,
        NUXT_QMS_AUTHORIZE_URL: `${bridge.url}/authorize`,
        NUXT_QMS_CLIENT_ID: 'fulfillment',
        NUXT_QMS_CLIENT_SECRET: 'local-dev-secret',
        NUXT_QMS_CALLBACK_URL: 'https://localhost:3100/auth/callback',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    for (let i = 0; i < 100; i++) {
      const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false)
      if (ok) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('履约服务未启动')
  })

  afterAll(async () => {
    app?.kill()
    await bridge?.close()
  })

  const get = (path: string, cookies: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: cookieHeader(cookies) } })

  /** 走完 登录 → QMS 授权 → 回调，返回回调响应和登录过程的 cookie */
  async function login(redirect: string, mockUser = 'u-001') {
    const start = await get(`/auth/login?redirect=${encodeURIComponent(redirect)}`)
    expect(start.status).toBe(302)
    const oauth = cookiesFrom(start)
    const authorize = new URL(start.headers.get('location')!)
    authorize.searchParams.set('mock_user', mockUser)
    const granted = await fetch(authorize, { redirect: 'manual' })
    expect(granted.status).toBe(302)
    const callback = new URL(granted.headers.get('location')!) // https://localhost:3100/auth/callback?code&state
    const res = await get(`${callback.pathname}${callback.search}`, oauth)
    return { res, oauth, callback }
  }

  it('未登录访问页面跳转登录，访问接口返回 401', async () => {
    const page = await get('/m')
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/auth/login?redirect=%2Fm')
    expect((await get('/api/me')).status).toBe(401)
    expect((await get('/api/reminders.json')).status).toBe(401)
  })

  it('完整登录后回到原页面，会话 Cookie 为 30 天 httpOnly Secure', async () => {
    const { res } = await login('/m')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/m')
    const raw = res.headers.getSetCookie().find((l) => l.startsWith('ft_session='))!
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/Secure/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    const expires = new Date(/Expires=([^;]+)/i.exec(raw)![1]!)
    expect(Math.round((expires.getTime() - Date.now()) / 86400_000)).toBe(30)

    const session = cookiesFrom(res)
    const me = await get('/api/me', session)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ id: 'u-001', name: '测试外协专员' })

    const page = await get('/m', session)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('我的提醒')

    const reminders = await get('/api/reminders', session)
    expect(await reminders.json()).toEqual({ items: [], unread: 0 })
  })

  it('同一个回调重放会被拒绝（授权码和登录状态一次性）', async () => {
    const { res, oauth, callback } = await login('/')
    expect(res.status).toBe(302)
    const replay = await get(`${callback.pathname}${callback.search}`, oauth)
    expect(replay.status).toBe(400)
  })

  it('state 被篡改时拒绝登录', async () => {
    const start = await get('/auth/login')
    const oauth = cookiesFrom(start)
    const granted = await fetch(start.headers.get('location')!, { redirect: 'manual' })
    const cb = new URL(granted.headers.get('location')!)
    cb.searchParams.set('state', 'forged')
    const res = await get(`${cb.pathname}${cb.search}`, oauth)
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie().some((l) => l.startsWith('ft_session='))).toBe(false)
  })

  it('没有登录状态 Cookie 的回调被拒绝（防登录 CSRF）', async () => {
    const start = await get('/auth/login')
    const granted = await fetch(start.headers.get('location')!, { redirect: 'manual' })
    const cb = new URL(granted.headers.get('location')!)
    expect((await get(`${cb.pathname}${cb.search}`)).status).toBe(400)
  })

  it('QMS 账号已停用时拒绝', async () => {
    const { res } = await login('/', 'u-002')
    expect(res.status).toBe(403)
  })

  it('回跳地址指向外站时回到首页', async () => {
    const { res } = await login('//evil.com/x')
    expect(res.headers.get('location')).toBe('/')
  })

  it('退出后会话失效', async () => {
    const { res } = await login('/')
    const session = cookiesFrom(res)
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader(session) } })
    expect(out.status).toBe(200)
    expect((await get('/api/me', session)).status).toBe(401)
  })
})
