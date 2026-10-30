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
  let db: PrismaClient
  const USERS = ['u-001', 'u-002', 'u-003']

  beforeAll(async () => {
    if (!existsSync(SERVER_ENTRY)) throw new Error('先运行 pnpm build')
    // 专用测试库：建表到最新迁移，再清空会话表
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    db = new PrismaClient({ datasourceUrl: DB })
    await db.session.deleteMany()
    await db.loginAttempt.deleteMany()
    for (const id of USERS) {
      const data = { username: id, realName: id, status: id === 'u-002' ? 'INACTIVE' : 'ACTIVE', isDeleted: false, updatedAt: new Date() }
      await db.qmsUser.upsert({ where: { id }, create: { id, ...data }, update: data })
    }
    bridge = await startMockIdentityBridge({
      users: { 'u-001': { name: '测试外协专员', active: true }, 'u-002': { name: '已停用', active: false }, 'u-003': { name: '测试项目经理', active: true }, 'u-unsynced': { name: 'Unsynced account', active: true } },
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
        NUXT_QMS_AUTHORIZE_URL: `${bridge.url}/identity/authorize`,
        NUXT_QMS_CLIENT_ID: 'fulfillment',
        NUXT_QMS_CLIENT_SECRET: 'local-dev-secret-local-dev-secret-0',
        NUXT_QMS_SYNC_ENABLED: '0', // 模拟身份桥上没挂同步接口；同步另见 sync.test.ts
        NUXT_QMS_CALLBACK_URL: 'https://localhost:3100/auth/callback',
        NUXT_ADMIN_USER_IDS: 'u-001',
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
    if (db) {
      await db.session.deleteMany({ where: { qmsUserId: { in: USERS } } })
      await db.qmsUser.deleteMany({ where: { id: { in: USERS } } })
      await db.$disconnect()
    }
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
    expect(await reminders.json()).toEqual({ items: [], unread: 0, digest: null, pinned: [] })
  })

  it('同一个回调重放会被拒绝（授权码和登录状态一次性）', async () => {
    const { res, oauth, callback } = await login('/')
    expect(res.status).toBe(302)
    const replay = await get(`${callback.pathname}${callback.search}`, oauth)
    expect(replay.status).toBe(400)
  })

  it('?prompt=login 透传到 QMS 授权地址（退出 / 切换账号时要求重新输入账号密码），其他参数不透传', async () => {
    // 授权地址可能是 hash 路由，参数在 # 之后，按 ? 后面解析
    const params = async (path: string) => new URLSearchParams((await get(path)).headers.get('location')!.split('?')[1])
    expect((await params('/auth/login?prompt=login')).get('prompt')).toBe('login')
    expect((await params('/auth/login?prompt=evil')).has('prompt')).toBe(false)
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

  it('QMS 账号已停用时拿不到授权码，也就建不了会话', async () => {
    const start = await get('/auth/login')
    const authorize = new URL(start.headers.get('location')!)
    authorize.searchParams.set('mock_user', 'u-002')
    const denied = await fetch(authorize, { redirect: 'manual' })
    expect(denied.status).toBe(401)
  })

  it('授权页收到的是 QMS 要求的参数名和格式', async () => {
    const start = await get('/auth/login?redirect=%2Fm')
    const q = new URL(start.headers.get('location')!).searchParams
    expect([...q.keys()].sort()).toEqual(['challenge', 'clientId', 'method', 'redirectUri', 'state'])
    expect(q.get('state')).toMatch(/^[\w-]{43,128}$/)
    expect(q.get('challenge')).toMatch(/^[\w-]{43}$/)
    expect(q.get('redirectUri')).toBe('https://localhost:3100/auth/callback')
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

  it.each(['INACTIVE', 'deleted', 'missing'])('rejects an existing %s account session, clears cookies, and revokes every device', async (state) => {
    const first = cookiesFrom((await login('/m')).res)
    const second = cookiesFrom((await login('/m')).res)
    const other = cookiesFrom((await login('/m', 'u-003')).res)
    const account = await db.qmsUser.findUniqueOrThrow({ where: { id: 'u-001' } })
    try {
      await db.session.updateMany({ where: { qmsUserId: 'u-001' }, data: { expiresAt: new Date(Date.now() + 10 * 86400_000) } })
      if (state === 'missing') await db.qmsUser.delete({ where: { id: 'u-001' } })
      else await db.qmsUser.update({ where: { id: 'u-001' }, data: state === 'deleted' ? { isDeleted: true } : { status: state } })
      const blockedLogin = (await login('/m')).res
      expect(blockedLogin.status).toBe(state === 'missing' ? 503 : 403)
      expect(blockedLogin.headers.getSetCookie().some((cookie) => cookie.startsWith('ft_session='))).toBe(false)
      const denied = await get('/api/me', first)
      expect(denied.status).toBe(401)
      expect(denied.headers.getSetCookie().some((cookie) => cookie.startsWith('ft_session=;'))).toBe(true)
      expect(await db.session.count({ where: { qmsUserId: 'u-001' } })).toBe(0)
      const page = await get('/m', second)
      expect(page.status).toBe(302)
      expect(page.headers.get('location')).toBe('/auth/login?redirect=%2Fm')
      expect((await get('/api/me', other)).status).toBe(200)
    } finally {
      await db.qmsUser.upsert({ where: { id: account.id }, create: account, update: { status: 'ACTIVE', isDeleted: false } })
    }
    expect((await get('/api/me', second)).status).toBe(401)
    expect((await get('/api/me', cookiesFrom((await login('/m')).res))).status).toBe(200)
  })

  it('returns a clear error instead of a redirect loop when the verified account has not synced', async () => {
    const { res } = await login('/m', 'u-unsynced')
    expect(res.status).toBe(503)
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith('ft_session='))).toBe(false)
    expect(await db.session.count({ where: { qmsUserId: 'u-unsynced' } })).toBe(0)
  })

  it('设置页接口只给管理员（NUXT_ADMIN_USER_IDS）：非管理员 403', async () => {
    const other = cookiesFrom((await login('/', 'u-003')).res)
    expect(await (await get('/api/me', other)).json()).toMatchObject({ id: 'u-003', isAdmin: false })
    expect((await get('/api/settings', other)).status).toBe(403)
    const write = (path: string, method: string, body: unknown) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(other), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await write('/api/settings/thresholds/W1', 'PUT', { remindHours: 1, yellowDays: 1, redDays: 1 })).status).toBe(403)
    expect((await write('/api/settings/off-days', 'POST', { date: '2026-10-01' })).status).toBe(403)
    expect((await write('/api/settings/roles', 'POST', { role: 'LEADER', userId: 'u-003' })).status).toBe(403)
    expect((await write('/api/settings/work-orders/X', 'PUT', { projectManagerId: 'u-003' })).status).toBe(403)

    const admin = cookiesFrom((await login('/')).res)
    expect(await (await get('/api/me', admin)).json()).toMatchObject({ id: 'u-001', isAdmin: true })
    const settings = await get('/api/settings', admin)
    expect(settings.status).toBe(200)
    expect((await settings.json()).thresholds.map((t: { rule: string }) => t.rule)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11'])
  })
})
