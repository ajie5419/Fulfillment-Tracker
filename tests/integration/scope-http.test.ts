/**
 * 可见范围与照片上传（R5）走真实接口：构建产物 + 真实 MySQL + 模拟身份桥。
 * 证明 canSee 收紧后项目经理看不到别人的工单（列表不含、详情 403），以及上传的魔数校验、大小限制、读取权限。
 * 运行：pnpm build && TEST_DATABASE_URL=mysql://… pnpm test:integration
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe.skipIf(!DB)('可见范围与照片（接口）', () => {
  let app: ChildProcess
  let base: string
  let bridge: { url: string; close: () => Promise<void> }
  let db: PrismaClient
  let uploadDir: string
  const MINE = 'T-WO-PM-MINE'
  const OTHER = 'T-WO-PM-OTHER'
  let otherIssueId = ''
  let otherPartId = ''

  beforeAll(async () => {
    if (!existsSync(SERVER_ENTRY)) throw new Error('先运行 pnpm build')
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    db = new PrismaClient({ datasourceUrl: DB })
    uploadDir = await mkdtemp(join(tmpdir(), 'ft-http-uploads-'))
    const now = new Date()
    // 只清本测试用到的数据
    await db.issue.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.part.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.workOrderExt.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.notifyRole.deleteMany({ where: { userId: { in: ['h-pm', 'h-pm2', 'h-lead'] } } })
    await db.qmsWorkOrder.createMany({
      data: [MINE, OTHER].map((wo) => ({ workOrderNumber: wo, customerName: '测试', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.workOrderExt.createMany({
      data: [
        { workOrderNumber: MINE, projectManagerId: 'h-pm' },
        { workOrderNumber: OTHER, projectManagerId: 'h-pm2' },
      ],
    })
    await db.notifyRole.create({ data: { role: 'LEADER', userId: 'h-lead' } })
    otherPartId = (await db.part.create({ data: { workOrderNumber: OTHER, name: '别人的工件' } })).id
    otherIssueId = (
      await db.issue.create({
        data: { issueNo: `YC-T-${Date.now()}`, workOrderNumber: OTHER, category: 'OTHER', description: '别人的异常', source: 'MANUAL', reporterId: 'h-pm2' },
      })
    ).id

    bridge = await startMockIdentityBridge({
      users: {
        'h-pm': { name: '项目经理甲', active: true },
        'h-pm2': { name: '项目经理乙', active: true },
        'h-lead': { name: '领导', active: true },
        'h-worker': { name: '一线', active: true },
      },
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
        NUXT_ADMIN_USER_IDS: 'h-admin',
        NUXT_UPLOAD_DIR: uploadDir,
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
    await db?.issue.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.$disconnect()
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true })
  })

  async function login(user: string) {
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' })
    const oauth = cookiesFrom(start)
    const authorize = new URL(start.headers.get('location')!)
    authorize.searchParams.set('mock_user', user)
    const granted = await fetch(authorize, { redirect: 'manual' })
    const cb = new URL(granted.headers.get('location')!)
    const res = await fetch(`${base}${cb.pathname}${cb.search}`, { redirect: 'manual', headers: { cookie: cookieHeader(oauth) } })
    return cookiesFrom(res)
  }
  const get = (path: string, s: Record<string, string>) => fetch(`${base}${path}`, { headers: { cookie: cookieHeader(s) } })

  it('项目经理只看到自己负责的工单：列表不含，详情 403；领导看全部', async () => {
    const pm = await login('h-pm')
    expect(await (await get('/api/me', pm)).json()).toMatchObject({ id: 'h-pm', limited: true })
    const wos = (await (await get('/api/work-orders', pm)).json()) as { workOrderNumber: string }[]
    expect(wos.map((w) => w.workOrderNumber)).toContain(MINE)
    expect(wos.map((w) => w.workOrderNumber)).not.toContain(OTHER)

    expect((await get(`/api/parts?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    expect((await get(`/api/parts?workOrderNumber=${MINE}`, pm)).status).toBe(200)
    expect((await get(`/api/parts/${otherPartId}/events`, pm)).status).toBe(403)
    expect((await get(`/api/issues/${otherIssueId}`, pm)).status).toBe(403)
    expect((await get(`/api/transit?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    const issues = (await (await get('/api/issues?dept=0', pm)).json()) as { id: string }[]
    expect(issues.some((i) => i.id === otherIssueId)).toBe(false)
    const board = (await (await get('/api/board', pm)).json()) as { rows: { workOrderNumber: string }[] }
    expect(board.rows.map((r) => r.workOrderNumber)).not.toContain(OTHER)
    // 写操作同样拦住
    const write = await fetch(`${base}/api/issues/${otherIssueId}/note`, {
      method: 'POST',
      headers: { cookie: cookieHeader(pm), 'content-type': 'application/json' },
      body: JSON.stringify({ note: '偷看' }),
    })
    expect(write.status).toBe(403)
    const report = await fetch(`${base}/api/issues`, {
      method: 'POST',
      headers: { cookie: cookieHeader(pm), 'content-type': 'application/json' },
      body: JSON.stringify({ workOrderNumber: OTHER, category: 'OTHER', description: 'x' }),
    })
    expect(report.status).toBe(403)

    const lead = await login('h-lead')
    expect((await get(`/api/issues/${otherIssueId}`, lead)).status).toBe(200)
    const leadWos = (await (await get('/api/work-orders', lead)).json()) as { workOrderNumber: string }[]
    expect(leadWos.map((w) => w.workOrderNumber)).toEqual(expect.arrayContaining([MINE, OTHER]))
    // 没有角色、也不是项目经理（一线）：看全部
    const worker = await login('h-worker')
    expect((await get(`/api/parts?workOrderNumber=${OTHER}`, worker)).status).toBe(200)
  })

  it('照片上传：魔数校验（改扩展名无效）、超大 413、未绑定只有上传人能读、绑定后按工单可见', async () => {
    const worker = await login('h-worker')
    const pm = await login('h-pm')
    const upload = (s: Record<string, string>, files: { data: Uint8Array<ArrayBuffer>; name: string; type: string }[]) => {
      const form = new FormData()
      for (const f of files) form.append('file', new Blob([f.data], { type: f.type }), f.name)
      return fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie: cookieHeader(s) }, body: form })
    }
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => i)])
    // 文本冒充 JPG：拒绝
    const fake = await upload(worker, [{ data: new TextEncoder().encode('<script>alert(1)</script>'), name: 'a.jpg', type: 'image/jpeg' }])
    expect(fake.status).toBe(400)
    expect((await fake.json()).message).toContain('只能上传')
    // 超过 3 × 8MB 的请求体：413
    const big = await upload(worker, [{ data: new Uint8Array(25 * 1024 * 1024), name: 'big.jpg', type: 'image/jpeg' }])
    expect(big.status).toBe(413)
    // 分块传输（没有 Content-Length）：411，不读进内存
    const chunked = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { cookie: cookieHeader(worker), 'content-type': 'multipart/form-data; boundary=x' },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('--x--')); c.close() } }),
      duplex: 'half',
    } as RequestInit)
    expect(chunked.status).toBe(411)
    // 单张超 8MB：400
    const one = new Uint8Array(8 * 1024 * 1024 + 10)
    one.set([0xff, 0xd8, 0xff])
    expect((await upload(worker, [{ data: one, name: 'x.jpg', type: 'image/jpeg' }])).status).toBe(400)
    // 正常上传：扩展名、类型都按内容判断
    const ok = await upload(worker, [{ data: jpg, name: '../../evil.png', type: 'text/html' }])
    expect(ok.status).toBe(200)
    const [saved] = (await ok.json()) as { id: string; mime: string; url: string }[]
    expect(saved).toMatchObject({ mime: 'image/jpeg', url: `/api/files/${saved!.id}` })

    const mineRead = await get(saved!.url, worker)
    expect(mineRead.status).toBe(200)
    expect(mineRead.headers.get('content-type')).toBe('image/jpeg')
    expect(mineRead.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await mineRead.arrayBuffer())).toEqual(jpg)
    expect((await get(saved!.url, pm)).status).toBe(404) // 未绑定：别人读不到
    expect((await get('/api/files/..%2F..%2Fetc%2Fpasswd', worker)).status).toBe(404)
    expect((await fetch(`${base}${saved!.url}`)).status).toBe(401) // 未登录

    // 一线在别人的工单上报（一线能看全部），带上照片 → 该工单的项目经理乙能看，项目经理甲不能
    const created = await fetch(`${base}/api/issues`, {
      method: 'POST',
      headers: { cookie: cookieHeader(worker), 'content-type': 'application/json' },
      body: JSON.stringify({ workOrderNumber: OTHER, category: 'WORKSHOP', description: '带照片', photoIds: [saved!.id] }),
    })
    expect(created.status).toBe(200)
    expect((await get(saved!.url, pm)).status).toBe(404)
    const pm2 = await login('h-pm2')
    expect((await get(saved!.url, pm2)).status).toBe(200)
  })
})
