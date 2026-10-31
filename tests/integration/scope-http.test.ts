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
import { BUSINESS_DEPT_NAME } from '../../shared/business-depts'

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
  const HTTP_USERS = ['h-pm', 'h-pm2', 'h-lead', 'h-worker', 'h-fin', 'h-tech', 'h-buyer', 'h-prod', 'h-qa', 'h-proc', 'h-admin', 'h-leader']
  // R13 部门对照：技术科 → 技术部（直接对照）；采购一组挂在供应部下（供应部 → 采购部，下级继承）；生产部没有对照（按名称）；检验科 → 质量部
  const DEPTS = [
    { id: 'T-DEPT-TECH', name: '技术科', parentId: '0' },
    { id: 'T-DEPT-SUPPLY', name: '供应部', parentId: '0' },
    { id: 'T-DEPT-BUY1', name: '采购一组', parentId: 'T-DEPT-SUPPLY' },
    { id: 'T-DEPT-PROD', name: '生产部', parentId: '0' },
    { id: 'T-DEPT-QA', name: '检验科', parentId: '0' },
    { id: 'T-DEPT-PROC', name: '工艺科', parentId: '0' },
  ]
  const USER_DEPT: Record<string, string> = { 'h-tech': 'T-DEPT-TECH', 'h-buyer': 'T-DEPT-BUY1', 'h-prod': 'T-DEPT-PROD', 'h-qa': 'T-DEPT-QA', 'h-proc': 'T-DEPT-PROC' }

  /** R14 总计划：节点、发布状态、调整记录、确认待办（plan_node 不挂工单外键，按工单号清） */
  async function cleanPlans() {
    const ids = (await db.planNode.findMany({ where: { workOrderNumber: { in: [MINE, OTHER] } }, select: { id: true } })).map((n) => n.id)
    await db.todo.deleteMany({ where: { refType: 'planNode', refId: { in: ids } } })
    await db.planChangeLog.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.planNode.deleteMany({ where: { id: { in: ids } } })
    await db.workOrderPlan.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.planTemplate.deleteMany({ where: { name: 'HTTP 测试模板' } })
  }

  beforeAll(async () => {
    if (!existsSync(SERVER_ENTRY)) throw new Error('先运行 pnpm build')
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    db = new PrismaClient({ datasourceUrl: DB })
    uploadDir = await mkdtemp(join(tmpdir(), 'ft-http-uploads-'))
    const now = new Date()
    // 只清本测试用到的数据
    await cleanPlans()
    await db.issue.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    // HTTP 用例会登记真实流转事件；再次运行前先按外键顺序清理本测试的事件。
    await db.flowEvent.deleteMany({ where: { step: { part: { workOrderNumber: { in: [MINE, OTHER] } } } } })
    await db.part.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.workOrderExt.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.notifyRole.deleteMany({ where: { userId: { in: ['h-pm', 'h-pm2', 'h-lead', 'h-fin'] } } })
    // 采购行 / 付款申请（R10）
    await db.paymentRequest.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.qmsWorkOrder.createMany({
      data: [MINE, OTHER].map((wo) => ({ workOrderNumber: wo, customerName: '测试', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.workOrderExt.createMany({
      data: [
        { workOrderNumber: MINE, projectManagerId: 'h-pm' },
        { workOrderNumber: OTHER, projectManagerId: 'h-pm2' },
      ],
    })
    await db.notifyRole.createMany({ data: [{ role: 'LEADER', userId: 'h-lead' }, { role: 'FINANCE', userId: 'h-fin' }] })
    // 发放单的接收人要在 QMS 用户副本里（R9）
    await db.release.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.drawingTask.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.assemblyNode.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db.qmsUser.deleteMany({ where: { id: { in: HTTP_USERS } } })
    await db.deptMapping.deleteMany({ where: { qmsDepartmentId: { in: DEPTS.map((d) => d.id) } } })
    await db.qmsDepartment.deleteMany({ where: { id: { in: DEPTS.map((d) => d.id) } } })
    await db.qmsDepartment.createMany({ data: DEPTS.map((d) => ({ ...d, status: 1, updatedAt: now })) })
    await db.deptMapping.createMany({
      data: [
        { qmsDepartmentId: 'T-DEPT-TECH', businessDept: 'TECH' },
        { qmsDepartmentId: 'T-DEPT-SUPPLY', businessDept: 'PURCHASE' },
        { qmsDepartmentId: 'T-DEPT-QA', businessDept: 'QUALITY' },
        { qmsDepartmentId: 'T-DEPT-PROC', businessDept: 'PROCESS' },
      ],
    })
    await db.qmsUser.createMany({ data: HTTP_USERS.map((id) => ({ id, username: id, realName: id, departmentId: USER_DEPT[id] ?? null, status: 'ACTIVE', updatedAt: now })) })
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
        'h-fin': { name: '财务', active: true },
        'h-tech': { name: '技术员', active: true },
        'h-buyer': { name: '采购员', active: true },
        'h-prod': { name: '生产员工', active: true },
        'h-qa': { name: '质检员', active: true },
        'h-proc': { name: '工艺员', active: true },
        'h-admin': { name: '管理员', active: true },
        'h-leader': { name: '班组长', active: true },
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
    if (db) await cleanPlans()
    await db?.release.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.drawingTask.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.assemblyNode.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.notifyRole.deleteMany({ where: { userId: 'h-worker' } })
    await db?.reminder.deleteMany({ where: { userId: { in: HTTP_USERS } } })
    await db?.paymentRequest.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.purchaseLine.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.notifyRole.deleteMany({ where: { userId: 'h-fin' } })
    await db?.qmsUser.deleteMany({ where: { id: { in: HTTP_USERS } } })
    await db?.deptMapping.deleteMany({ where: { qmsDepartmentId: { in: DEPTS.map((d) => d.id) } } })
    await db?.qmsDepartment.deleteMany({ where: { id: { in: DEPTS.map((d) => d.id) } } })
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

  it('项目全景 HTTP 权限跟随看板：未登录 401，项目经理只看自己，领导看全部', async () => {
    expect((await fetch(`${base}/api/panorama`)).status).toBe(401)
    for (const user of ['h-pm', 'h-lead', 'h-admin']) {
      const session = await login(user)
      const response = await get('/api/panorama', session)
      expect(response.status).toBe(200)
      const panorama = await response.json()
      const board = await (await get('/api/board?closed=1', session)).json()
      const inProgress = board.rows.filter((r: { status: string }) => r.status === 'IN_PROGRESS')
      expect(panorama.counts).toEqual({
        inProgress: inProgress.length,
        normal: inProgress.filter((r: { color: string }) => r.color === 'GREEN').length,
        abnormal: inProgress.filter((r: { color: string }) => r.color === 'RED' || r.color === 'YELLOW').length,
        completed: board.rows.filter((r: { status: string }) => r.status === 'COMPLETED').length,
        notStarted: board.rows.filter((r: { status: string }) => r.status === 'OPEN').length,
        unaccepted: null, unacceptedAvailable: false,
      })
      const managers = panorama.byManager.map((m: { projectManagerId: string | null }) => m.projectManagerId)
      if (user === 'h-pm') expect(managers).toEqual(['h-pm'])
      else expect(managers).toContain('h-pm2')
    }
  })

  it('状态监控新接口：未登录 401，普通项目经理 403，领导可看全部在制分布并按实体 / 状态下钻', async () => {
    expect((await fetch(`${base}/api/monitoring/status`)).status).toBe(401)
    const pm = await login('h-pm')
    expect((await get('/api/monitoring/status', pm)).status).toBe(403)
    expect((await get('/api/monitoring/entities?entityType=part&status=ACTIVE', pm)).status).toBe(403)
    const leader = await login('h-lead')
    const response = await get('/api/monitoring/status', leader)
    expect(response.status).toBe(200)
    const summary = await response.json()
    expect(summary.threshold).toMatchObject({ yellowDays: 7, redDays: 14, remindHours: null })
    expect(summary.steps.map((r: { status: string }) => r.status)).toEqual(['PENDING', 'OUT', 'IN_PROGRESS', 'BLOCKED'])
    const listResponse = await get('/api/monitoring/entities?entityType=part&status=ACTIVE&pageSize=100', leader)
    expect(listResponse.status).toBe(200)
    const list = await listResponse.json()
    expect(list.total).toBe(summary.parts[0].count)
    expect(list.rows.find((r: { id: string }) => r.id === otherPartId)).toMatchObject({ entityType: 'part', workOrderNumber: OTHER, status: 'ACTIVE', sinceSource: 'statusSince', link: expect.stringContaining(`part=${otherPartId}`) })
    expect((await get('/api/monitoring/entities?page=0', leader)).status).toBe(400)
    expect((await get('/api/monitoring/entities?status=DONE', leader)).status).toBe(400)
  })

  it('停滞红线 HTTP 下钻含两类在制对象，total 与 redCount 一致，拒绝非法级别且保留权限', async () => {
    const leader = await login('h-lead')
    const summary = await (await get('/api/monitoring/status', leader)).json()
    const response = await get('/api/monitoring/entities?level=RED&pageSize=100', leader)
    expect(response.status).toBe(200)
    const list = await response.json()
    expect(list.total).toBe(summary.redCount)
    expect(list.rows.every((r: { level: string }) => r.level === 'RED')).toBe(true)
    expect((await get('/api/monitoring/entities?level=BLUE', leader)).status).toBe(400)
    expect((await get('/api/monitoring/entities?level=RED', await login('h-pm'))).status).toBe(403)
  })

  it('W11 复用设置阈值接口：管理员可改、非法边界拒绝，监控接口随配置更新', async () => {
    const admin = await login('h-admin')
    const prior = await db.threshold.findUnique({ where: { rule: 'W11' } })
    const save = (yellowDays: number, redDays: number) => fetch(`${base}/api/settings/thresholds/W11`, {
      method: 'PUT', headers: { cookie: cookieHeader(admin), 'content-type': 'application/json' },
      body: JSON.stringify({ remindHours: null, yellowDays, redDays }),
    })
    try {
      expect((await save(8, 16)).status).toBe(200)
      expect((await (await get('/api/monitoring/status', admin)).json()).threshold).toEqual({ remindHours: null, yellowDays: 8, redDays: 16 })
      expect((await save(16, 8)).status).toBe(400)
      expect((await save(0, 8)).status).toBe(400)
      expect((await save(7, 366)).status).toBe(400)
    } finally {
      if (prior) await db.threshold.upsert({ where: { rule: 'W11' }, create: prior, update: prior })
      else await db.threshold.deleteMany({ where: { rule: 'W11' } })
    }
  })

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

  it('发放单（R9）：按工单可见范围新建/查看；接收人不受范围限制能看能签；只能签自己的；PDF 附件按发放单权限读取', async () => {
    const pm = await login('h-pm')
    const pm2 = await login('h-pm2')
    const worker = await login('h-worker')
    const tech = await login('h-tech')
    const post = (s: Record<string, string>, path: string, body: object) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookieHeader(s), 'content-type': 'application/json' }, body: JSON.stringify(body) })

    // 项目经理甲不能在别人的工单上发放
    expect((await post(pm, '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: 'x', userIds: ['h-worker'] })).status).toBe(403)

    // 附件：PDF 只能按附件传，按照片传 400
    const pdf = new TextEncoder().encode('%PDF-1.4\n%test\n')
    const upload = (kind: string) => {
      const form = new FormData()
      form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'drawing.pdf')
      return fetch(`${base}/api/uploads${kind ? `?kind=${kind}` : ''}`, { method: 'POST', headers: { cookie: cookieHeader(tech) }, body: form })
    }
    expect((await upload('')).status).toBe(400)
    const up = await upload('attachment')
    expect(up.status).toBe(200)
    const [att] = (await up.json()) as { id: string; mime: string; url: string }[]
    expect(att!.mime).toBe('application/pdf')

    // R13：建发放单只限技术部、管理员 —— 项目经理甲在自己的工单上也不行，一线也不行
    const denied = await post(pm, '/api/releases', { type: 'CHANGE', workOrderNumber: MINE, description: 'x', userIds: ['h-worker'] })
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { message: string }).message).toBe('只有技术部、管理员可以发放图纸和设计变更；工艺部可以发放工艺文件')
    expect((await post(worker, '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-pm'] })).status).toBe(403)
    // 技术员（技术科经部门对照算技术部）在甲的工单上发给乙（乙看不到甲的工单）和一线
    const created = await post(tech, '/api/releases', { type: 'CHANGE', workOrderNumber: MINE, description: '孔位变更', userIds: ['h-pm2', 'h-worker'], attachmentIds: [att!.id] })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    // 乙是接收人：能看详情和附件（虽然不是他的工单）
    const detail = await get(`/api/releases/${id}`, pm2)
    expect(detail.status).toBe(200)
    const d = (await detail.json()) as { myReceipt: { id: string }; permissions: { sign: boolean; void: boolean } }
    expect(d.permissions).toMatchObject({ sign: true, void: false })
    const file = await get(att!.url, pm2)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('application/pdf')
    // 一线不能替乙签收；乙不能作废
    expect((await post(worker, `/api/receipts/${d.myReceipt.id}/sign`, {})).status).toBe(403)
    expect((await post(pm2, `/api/releases/${id}/void`, {})).status).toBe(403)
    expect((await post(pm2, `/api/receipts/${d.myReceipt.id}/reject`, { reason: '' })).status).toBe(400)
    expect((await post(pm2, `/api/receipts/${d.myReceipt.id}/sign`, {})).status).toBe(200)
    // 乙的"待签收"清空
    expect(((await (await get('/api/receipts?tab=pending', pm2)).json()) as unknown[]).length).toBe(0)

    // 别人工单上的发放单：甲（不是接收人）看不到，列表也没有，附件 404
    const lead = await login('h-lead')
    expect((await post(lead, '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: 'x', userIds: ['h-worker'] })).status).toBe(403)
    const other = await post(tech, '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: '别的工单', userIds: ['h-worker'] })
    expect(other.status).toBe(200)
    const otherId = ((await other.json()) as { id: string }).id
    expect((await get(`/api/releases/${otherId}`, pm)).status).toBe(403)
    const list = (await (await get('/api/releases', pm)).json()) as { id: string }[]
    expect(list.some((r) => r.id === otherId)).toBe(false)
    expect(list.some((r) => r.id === id)).toBe(true)
    expect((await post(pm, `/api/releases/${otherId}/void`, {})).status).toBe(403)
    // 作废仍限发放人或管理员：技术员能作废自己发的
    expect((await post(tech, `/api/releases/${otherId}/void`, {})).status).toBe(200)
    // 签收待办不能转交
    const todos = (await (await get('/api/todos', worker)).json()) as { id: string; action: string }[]
    const signTodo = todos.find((t) => t.action === 'SIGN_RELEASE')!
    expect((await post(worker, `/api/todos/${signTodo.id}/transfer`, { toUserId: 'h-lead' })).status).toBe(400)
  })

  it('todo delegation rejects theft and cross-scope recipients while preserving authorized change confirmation', async () => {
    const post = (session: Record<string, string>, path: string, body: object) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookieHeader(session), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const pm = await login('h-pm')
    const pm2 = await login('h-pm2')
    const prod = await login('h-prod')
    const admin = await login('h-admin')
    const release = await db.release.create({ data: { releaseNo: `FF-T-${Date.now()}`, type: 'CHANGE', workOrderNumber: OTHER, description: 'Delegation authorization', issuerId: 'h-tech' } })
    const todo = await db.todo.create({ data: { ownerId: 'h-prod', action: 'CONFIRM_CHANGE', refType: 'release', refId: release.id } })
    const transferUrl = `/api/todos/${todo.id}/transfer`
    try {
      expect((await get(`/api/releases/${release.id}`, pm)).status).toBe(403)
      expect((await post(pm, transferUrl, { toUserId: 'h-pm' })).status).toBe(403)
      expect((await post(admin, transferUrl, { toUserId: 'h-pm2' })).status).toBe(403)
      expect((await post(prod, transferUrl, { toUserId: 'h-pm' })).status).toBe(403)
      expect((await post(prod, transferUrl, { toUserId: 'h-pm', recipientIsAdmin: true })).status).toBe(400)
      expect(await db.todo.findUniqueOrThrow({ where: { id: todo.id } })).toMatchObject({ status: 'OPEN', ownerId: 'h-prod' })
      expect(await db.todo.count({ where: { refType: 'release', refId: release.id, ownerId: 'h-pm' } })).toBe(0)
      expect((await get(`/api/releases/${release.id}`, pm)).status).toBe(403)
      expect((await post(pm, `/api/releases/${release.id}/confirm-change`, {})).status).toBe(403)

      await db.qmsUser.update({ where: { id: 'h-pm2' }, data: { status: 'INACTIVE' } })
      expect((await post(prod, transferUrl, { toUserId: 'h-pm2' })).status).toBe(400)
      await db.qmsUser.update({ where: { id: 'h-pm2' }, data: { status: 'ACTIVE' } })
      expect((await post(prod, transferUrl, { toUserId: 'h-pm2' })).status).toBe(200)
      expect(await db.todo.findUniqueOrThrow({ where: { id: todo.id } })).toMatchObject({ status: 'TRANSFERRED' })
      expect((await get(`/api/releases/${release.id}`, pm2)).status).toBe(200)
      expect((await post(pm2, `/api/releases/${release.id}/confirm-change`, {})).status).toBe(200)
      expect(await db.release.findUniqueOrThrow({ where: { id: release.id } })).toMatchObject({ changeConfirmedBy: 'h-pm2' })
    } finally {
      await db.qmsUser.update({ where: { id: 'h-pm2' }, data: { status: 'ACTIVE' } })
      await db.todo.deleteMany({ where: { refType: 'release', refId: release.id } })
      await db.release.delete({ where: { id: release.id } })
    }
  })

  it('采购到货与付款（R10）：按工单可见范围增查改、确认到货；模板下载 + 批量导入；只有财务能标记已付', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const fin = await login('h-fin')
    const buyer = await login('h-buyer')
    const worker = await login('h-worker')
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    const later = new Date(Date.now() + 8 * 3_600_000 + 30 * 86_400_000).toISOString().slice(0, 10)

    // 甲不能在别人的工单上登记；自己的可以
    expect((await send(pm, 'POST', '/api/purchases', { workOrderNumber: OTHER, materialName: 'x', quantity: 1, needDate: later })).status).toBe(403)
    const mine = await send(pm, 'POST', '/api/purchases', { workOrderNumber: MINE, materialName: '回转支承', quantity: 1, needDate: later })
    expect(mine.status).toBe(200)
    const mineId = ((await mine.json()) as { id: string }).id
    // R13：采购行只限采购部、该工单项目经理、管理员 —— 领导、一线不行；采购员（采购一组随上级供应部算采购部）能在任何工单上登记
    expect((await send(lead, 'POST', '/api/purchases', { workOrderNumber: OTHER, materialName: '钢板', quantity: 2, needDate: later })).status).toBe(403)
    const workerDenied = await send(worker, 'POST', '/api/purchases', { workOrderNumber: MINE, materialName: 'x', quantity: 1, needDate: later })
    expect(workerDenied.status).toBe(403)
    expect(((await workerDenied.json()) as { message: string }).message).toContain('只有采购部、该工单项目经理或管理员')
    const otherRes = await send(buyer, 'POST', '/api/purchases', { workOrderNumber: OTHER, materialName: '钢板', quantity: 2, needDate: later })
    expect(otherRes.status).toBe(200)
    const otherId = ((await otherRes.json()) as { id: string }).id
    // 一线能看（看全部）但改不了、标不了到货
    expect((await get(`/api/purchases/${otherId}`, worker)).status).toBe(200)
    expect((await send(worker, 'PATCH', `/api/purchases/${otherId}`, { note: 'x' })).status).toBe(403)
    expect((await send(worker, 'POST', `/api/purchases/${otherId}/arrive`, { source: 'MOBILE' })).status).toBe(403)
    expect((await send(worker, 'DELETE', `/api/purchases/${otherId}`)).status).toBe(403)
    // 日期格式校验
    expect((await send(pm, 'POST', '/api/purchases', { workOrderNumber: MINE, materialName: 'x', quantity: 1, needDate: '2026/1/1' })).status).toBe(400)

    // 列表只含自己的；别人的详情 / 修改 / 确认到货 403
    const list = (await (await get('/api/purchases?view=all', pm)).json()) as { rows: { id: string }[] }
    expect(list.rows.map((r) => r.id)).toContain(mineId)
    expect(list.rows.map((r) => r.id)).not.toContain(otherId)
    expect((await get(`/api/purchases?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    expect((await get(`/api/purchases/${otherId}`, pm)).status).toBe(403)
    expect((await send(pm, 'PATCH', `/api/purchases/${otherId}`, { note: 'x' })).status).toBe(403)
    expect((await send(pm, 'POST', `/api/purchases/${otherId}/arrive`, { source: 'MOBILE' })).status).toBe(403)
    expect((await send(pm, 'DELETE', `/api/purchases/${otherId}`)).status).toBe(403)
    const arrived = await send(pm, 'POST', `/api/purchases/${mineId}/arrive`, { source: 'MOBILE', arrivedDate: today })
    expect(arrived.status).toBe(200)
    expect(((await (await get(`/api/purchases/${mineId}`, pm)).json()) as { status: string }).status).toBe('ARRIVED')

    // 模板下载是 xlsx；导入：别人的工单行报错、整批不导；自己的工单成功
    const tpl = await get('/api/purchases/template', pm)
    expect(tpl.status).toBe(200)
    expect(tpl.headers.get('content-type')).toContain('spreadsheetml')
    const ExcelJS = (await import('exceljs')).default
    const book = async (wo: string) => {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await tpl.clone().arrayBuffer())
      const ws = wb.worksheets[0]!
      ws.addRow([wo, '导入的物料', null, 3, '件', null, later])
      return Buffer.from(await wb.xlsx.writeBuffer())
    }
    const upload = (sess: Record<string, string>, data: Uint8Array, name = 'p.xlsx') => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(data)]), name)
      return fetch(`${base}/api/purchases/import`, { method: 'POST', headers: { cookie: cookieHeader(sess) }, body: form })
    }
    const denied = await upload(pm, await book(OTHER))
    expect(denied.status).toBe(200)
    expect(await denied.json()).toMatchObject({ imported: 0, errors: [{ row: 2, messages: [`无权查看工单 ${OTHER}`] }] })
    const ok = await upload(pm, await book(MINE))
    expect(await ok.json()).toMatchObject({ imported: 1, errors: [] })
    // 一线整个导入都不允许
    expect((await upload(worker, await book(MINE))).status).toBe(403)
    expect((await upload(pm, new TextEncoder().encode('a,b,c'), 'p.csv')).status).toBe(400)

    // 付款申请：甲申请；甲不能标记已付，财务可以；甲看不到别人工单的付款申请
    expect((await send(pm, 'POST', '/api/payments', { purchaseLineIds: [otherId], amount: 1, requestDate: today, blocksDelivery: false })).status).toBe(403)
    const pay = await send(pm, 'POST', '/api/payments', { purchaseLineIds: [mineId], amount: 1200.5, requestDate: today, blocksDelivery: true })
    expect(pay.status).toBe(200)
    const payId = ((await pay.json()) as { id: string }).id
    expect((await send(lead, 'POST', '/api/payments', { purchaseLineIds: [otherId], amount: 9, requestDate: today, blocksDelivery: false })).status).toBe(403)
    expect((await send(worker, 'POST', '/api/payments', { purchaseLineIds: [otherId], amount: 9, requestDate: today, blocksDelivery: false })).status).toBe(403)
    const otherPay = await send(buyer, 'POST', '/api/payments', { purchaseLineIds: [otherId], amount: 9, requestDate: today, blocksDelivery: false })
    expect(otherPay.status).toBe(200)
    const otherPayId = ((await otherPay.json()) as { id: string }).id

    // R13 付款金额：财务、采购部、领导、该工单项目经理能看；一线的接口里金额是 null（采购行关联的付款也是）
    type PayRow = { id: string; amount: number | null }
    const amounts = async (s: Record<string, string>) => new Map(((await (await get('/api/payments?status=ALL', s)).json()) as PayRow[]).map((p) => [p.id, p.amount]))
    expect((await amounts(worker)).get(payId)).toBeNull()
    expect((await amounts(worker)).get(otherPayId)).toBeNull()
    expect((await amounts(pm)).get(payId)).toBe(1200.5)
    expect((await amounts(lead)).get(otherPayId)).toBe(9)
    expect((await amounts(buyer)).get(payId)).toBe(1200.5)
    expect((await amounts(fin)).get(otherPayId)).toBe(9)
    const workerLine = (await (await get(`/api/purchases/${mineId}`, worker)).json()) as { payments: PayRow[] }
    expect(workerLine.payments.map((p) => p.amount)).toEqual([null])
    const workerLines = (await (await get('/api/purchases?view=all', worker)).json()) as { rows: { id: string; payments: PayRow[] }[] }
    expect(workerLines.rows.find((r) => r.id === mineId)!.payments.map((p) => p.amount)).toEqual([null])
    const pmLine = (await (await get(`/api/purchases/${mineId}`, pm)).json()) as { payments: PayRow[] }
    expect(pmLine.payments.map((p) => p.amount)).toEqual([1200.5])
    const pmPays = (await (await get('/api/payments?status=ALL', pm)).json()) as { id: string; permissions: { setStatus: boolean } }[]
    expect(pmPays.map((p) => p.id)).toEqual([payId])
    expect(pmPays[0]!.permissions.setStatus).toBe(false)
    expect((await send(pm, 'POST', `/api/payments/${payId}/status`, { status: 'PAID' })).status).toBe(403)
    expect((await send(pm, 'POST', `/api/payments/${otherPayId}/status`, { status: 'PAID' })).status).toBe(403)
    const finPays = (await (await get('/api/payments', fin)).json()) as { id: string; permissions: { setStatus: boolean } }[]
    expect(finPays.map((p) => p.id)).toEqual(expect.arrayContaining([payId, otherPayId]))
    expect((await send(fin, 'POST', `/api/payments/${payId}/status`, { status: 'PAID', note: '已电汇' })).status).toBe(200)
    expect((await send(fin, 'POST', `/api/payments/${payId}/status`, { status: 'DONE' })).status).toBe(400)
    // 已付的不能删
    expect((await send(pm, 'DELETE', `/api/payments/${payId}`)).status).toBe(400)
  })
  it('设计任务（R11）：按工单可见范围增查改；只有设计负责人本人或管理员能标记设计完成；负责人本人不受工单范围限制；一键发放关联任务', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const worker = await login('h-worker')
    const tech = await login('h-tech')
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)

    // 项目经理甲不能在别人的工单上建（看不到）；R13：自己的工单也不能建（设计任务只限技术部、管理员），领导也不行
    expect((await send(pm, 'POST', '/api/drawings', { workOrderNumber: OTHER, componentName: 'x', planDate: later })).status).toBe(403)
    expect((await send(tech, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: 'x', planDate: '2026/1/1' })).status).toBe(400)
    const pmDenied = await send(pm, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: 'x', planDate: later })
    expect(pmDenied.status).toBe(403)
    expect(((await pmDenied.json()) as { message: string }).message).toBe('只有技术部或管理员可以编辑设计任务')
    expect((await send(lead, 'POST', '/api/drawings', { workOrderNumber: OTHER, componentName: 'x', planDate: later })).status).toBe(403)
    // 技术员在甲的工单上建（负责人是一线 h-worker）
    const mine = await send(tech, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: '主梁总图', ownerId: 'h-worker', planDate: later })
    expect(mine.status).toBe(200)
    const mineId = ((await mine.json()) as { id: string }).id
    // 技术员在别人的工单上建一个，设计负责人是甲（甲看不到这个工单）
    const other = await send(tech, 'POST', '/api/drawings', { workOrderNumber: OTHER, componentName: '别人的图', ownerId: 'h-pm', planDate: later })
    const otherId = ((await other.json()) as { id: string }).id

    // 列表只含可见工单；"我的设计任务"含负责人是自己的（不受范围限制）
    const list = (await (await get('/api/drawings?view=all', pm)).json()) as { rows: { id: string }[] }
    expect(list.rows.map((r) => r.id)).toContain(mineId)
    expect(list.rows.map((r) => r.id)).not.toContain(otherId)
    expect((await get(`/api/drawings?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    const myList = (await (await get('/api/drawings?mine=1&view=all', pm)).json()) as { rows: { id: string; permissions: { markDrawn: boolean } }[] }
    expect(myList.rows.map((r) => r.id)).toEqual([otherId])
    expect(myList.rows[0]!.permissions.markDrawn).toBe(true)
    expect((await get(`/api/drawings/${otherId}`, pm)).status).toBe(200)
    // 负责人本人也要看得到工单才能改任务本身
    expect((await send(pm, 'PATCH', `/api/drawings/${otherId}`, { note: 'x' })).status).toBe(403)

    // 标记设计完成：不是负责人 → 403；负责人本人 → 200；看不到工单的负责人也能标
    expect((await send(pm, 'POST', `/api/drawings/${mineId}/drawn`, {})).status).toBe(403)
    expect((await send(lead, 'POST', `/api/drawings/${mineId}/drawn`, {})).status).toBe(403)
    const drawn = await send(worker, 'POST', `/api/drawings/${mineId}/drawn`, {})
    expect(drawn.status).toBe(200)
    expect(await drawn.json()).toMatchObject({ status: 'DRAWN' })
    expect((await send(pm, 'POST', `/api/drawings/${otherId}/drawn`, {})).status).toBe(200)
    // R13：编辑只限技术部、管理员（能看到工单的项目经理、设计负责人本人都不行）
    expect((await send(pm, 'PATCH', `/api/drawings/${mineId}`, { note: 'x' })).status).toBe(403)
    expect((await send(worker, 'PATCH', `/api/drawings/${mineId}`, { note: 'x' })).status).toBe(403)
    expect((await send(tech, 'PATCH', `/api/drawings/${mineId}`, { note: '技术部能改' })).status).toBe(200)

    // 一键发放：发放单记下 drawingTaskId，任务完成；别人工单的任务甲不能发
    const rel = await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: '主梁总图发放', userIds: ['h-worker'], drawingTaskId: mineId })
    expect(rel.status).toBe(200)
    expect(await rel.json()).toMatchObject({ drawing: { status: 'DONE' } })
    expect((await send(pm, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: 'x', userIds: ['h-worker'], drawingTaskId: otherId })).status).toBe(403)
    expect((await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-worker'], drawingTaskId: otherId })).status).toBe(400)
    const load = await get('/api/drawings/load', pm)
    expect(load.status).toBe(200)
  })

  it('齐套（R12）：能看到工单就能看；新建 / 编辑限生产经理、该工单项目经理、管理员；节点负责人本人不受工单范围限制（只读）', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const worker = await login('h-worker')
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)

    // 项目经理甲：自己的工单能建，别人的工单 403（看不到）；日期格式不对 400
    expect((await send(pm, 'POST', '/api/kitting', { workOrderNumber: OTHER, name: 'x', needDate: later })).status).toBe(403)
    expect((await send(pm, 'POST', '/api/kitting', { workOrderNumber: MINE, name: 'x', needDate: '2026/1/1' })).status).toBe(400)
    const mine = await send(pm, 'POST', '/api/kitting', { workOrderNumber: MINE, name: '主梁总装', needDate: later })
    expect(mine.status).toBe(200)
    const mineId = ((await mine.json()) as { id: string }).id
    // 看得到工单、但不是生产经理 / 项目经理 / 管理员：不能建
    expect((await send(worker, 'POST', '/api/kitting', { workOrderNumber: MINE, name: 'x', needDate: later })).status).toBe(403)
    expect((await send(lead, 'POST', '/api/kitting', { workOrderNumber: MINE, name: 'x', needDate: later })).status).toBe(403)
    expect((await send(lead, 'PATCH', `/api/kitting/${mineId}`, { name: 'x' })).status).toBe(403)

    // 生产经理（生产部负责人）：所有工单都能建；在别人的工单上建一个，负责人是甲（甲看不到这个工单）
    await db.notifyRole.create({ data: { role: 'DEPT_HEAD', userId: 'h-worker', department: '生产部' } })
    const other = await send(worker, 'POST', '/api/kitting', { workOrderNumber: OTHER, name: '别人的节点', needDate: later, ownerId: 'h-pm' })
    expect(other.status).toBe(200)
    const otherId = ((await other.json()) as { id: string }).id

    // 列表只含可见工单；能看到就能看（领导看全部，但不能改）
    const list = (await (await get('/api/kitting', pm)).json()) as { rows: { id: string; canEdit: boolean }[] }
    expect(list.rows.map((r) => r.id)).toEqual([mineId])
    expect(list.rows[0]!.canEdit).toBe(true)
    expect((await get(`/api/kitting?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    expect((await get(`/api/kitting/options?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    const leadList = (await (await get('/api/kitting?incomplete=0', lead)).json()) as { rows: { id: string; canEdit: boolean }[]; canCreate: boolean }
    expect(leadList.rows.map((r) => r.id)).toEqual(expect.arrayContaining([mineId, otherId]))
    expect(leadList.rows.every((r) => !r.canEdit)).toBe(true)
    expect(leadList.canCreate).toBe(false)
    // 负责人本人：手机"我负责的"和提醒跳转能看，但改不了
    const myList = (await (await get('/api/kitting?mine=1', pm)).json()) as { rows: { id: string }[] }
    expect(myList.rows.map((r) => r.id)).toEqual([otherId])
    expect((await get(`/api/kitting/${otherId}`, pm)).status).toBe(200)
    expect((await send(pm, 'PATCH', `/api/kitting/${otherId}`, { name: 'x' })).status).toBe(403)
    expect((await send(pm, 'DELETE', `/api/kitting/${otherId}`)).status).toBe(403)
    expect((await get(`/api/kitting/${otherId}`, lead)).status).toBe(200)

    // 编辑：选别的工单的工件 400；项目经理改自己的；生产经理能删
    expect((await send(pm, 'PATCH', `/api/kitting/${mineId}`, { partIds: [otherPartId] })).status).toBe(400)
    const patched = await send(pm, 'PATCH', `/api/kitting/${mineId}`, { name: '主梁总装（改）', partIds: [] })
    expect(patched.status).toBe(200)
    expect((await send(worker, 'DELETE', `/api/kitting/${mineId}`)).status).toBe(200)
    expect((await get(`/api/kitting/${mineId}`, pm)).status).toBe(400)
  })
  it('权限 R13：部门对照决定业务部门和菜单；工件工序、开工完工按角色收紧；领导总览、部门对照设置', async () => {
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const me = async (s: Record<string, string>) =>
      (await (await get('/api/me', s)).json()) as { businessDept: string | null; menu: string[]; pmOf: string[]; can: Record<string, boolean> }
    const tech = await login('h-tech')
    const buyer = await login('h-buyer')
    const prod = await login('h-prod')
    const qa = await login('h-qa')
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const admin = await login('h-admin')

    // 业务部门：直接对照 / 随上级 / 按名称（没有对照）
    expect(await me(tech)).toMatchObject({ businessDept: 'TECH', menu: ['deptPlan', 'tech', 'process'] })
    expect(await me(buyer)).toMatchObject({ businessDept: 'PURCHASE', menu: ['deptPlan', 'purchase', 'kitting'], can: { purchase: true, seeAmount: true } })
    expect(await me(prod)).toMatchObject({ businessDept: 'PRODUCTION', menu: ['deptPlan', 'process', 'production', 'releases'], can: { route: true, stepAction: true, mobileSend: true } })
    // 10-24 工艺部：生产管理（定工艺路线）、发放签收（只发工艺文件）；不能开工完工
    const proc = await login('h-proc')
    expect(await me(proc)).toMatchObject({ businessDept: 'PROCESS', menu: ['deptPlan', 'process', 'production', 'releases'], can: { route: true, stepAction: false, release: true, releaseProcessOnly: true, drawing: false, processDoc: true } })
    expect((await send(proc, 'POST', '/api/parts', { workOrderNumber: MINE, name: 'R13 工艺建的', quantity: 1 })).status).toBe(200)
    expect((await send(proc, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'] })).status).toBe(403)
    expect((await send(proc, 'POST', '/api/releases', { type: 'CHANGE', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'] })).status).toBe(403)
    expect((await send(proc, 'POST', '/api/releases', { type: 'PROCESS', workOrderNumber: MINE, description: '车架工艺卡', userIds: ['h-prod'] })).status).toBe(200)
    expect(await me(tech)).toMatchObject({ can: { releaseProcessOnly: false, processDoc: false } })
    // 10-27 工艺模块：料单 / 工艺状态只有工艺部（和管理员）能改；技术部、生产部只读；设计任务不存在报错不放过
    {
      const t = await db.drawingTask.create({ data: { workOrderNumber: MINE, componentName: 'R13 工艺部件', ownerId: 'h-tech', planDate: new Date('2026-12-01') } })
      const body = { kind: 'MATERIAL', action: 'start' }
      expect((await send(tech, 'POST', `/api/process/${t.id}/action`, body)).status).toBe(403)
      expect((await send(prod, 'POST', `/api/process/${t.id}/action`, body)).status).toBe(403)
      expect((await send(proc, 'POST', `/api/process/${t.id}/action`, body)).status).toBe(400)
      expect((await send(tech, 'POST', `/api/drawings/${t.id}/drawn`, {})).status).toBe(200)
      const releaseResponse = await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: '工艺编制前正式发放', drawingTaskId: t.id, userIds: ['h-proc'] })
      expect(releaseResponse.status).toBe(200)
      expect((await send(proc, 'POST', `/api/process/${t.id}/action`, body)).status).toBe(200)
      expect((await send(proc, 'POST', `/api/process/no-such-task/action`, body)).status).toBe(400)
      const list = (await (await get(`/api/process?workOrderNumber=${encodeURIComponent(MINE)}&view=all`, tech)).json()) as { rows: { id: string; materialStatus: string; actions: { material: string[] } }[] }
      expect(list.rows.find((r) => r.id === t.id)).toMatchObject({ materialStatus: 'DRAFTING', actions: { material: [] } })
      expect((await get(`/api/process/${t.id}/logs`, tech)).status).toBe(200)
      await db.release.deleteMany({ where: { drawingTaskId: t.id } })
      await db.drawingTask.delete({ where: { id: t.id } })
    }
    // 10-24 图纸发放附 BOM：按 kind=bom 上传 .xlsx → 预览（能发图纸的人）→ 发放时按图号建工件；签收人能下载 BOM 表
    {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('BOM').addRows([['图号', '版号', '部件名称', '数量'], ['HTTP-BOM-1', 'A', '接口主梁', 1], ['HTTP-BOM-2', null, '接口端梁', 2]])
      const xlsx = new Uint8Array(await wb.xlsx.writeBuffer())
      const form = (data: Uint8Array, name: string, extra: Record<string, string> = {}) => {
        const f = new FormData()
        for (const [k, v] of Object.entries(extra)) f.append(k, v)
        f.append('file', new Blob([new Uint8Array(data)]), name)
        return f
      }
      const upBom = (sess: Record<string, string>, data: Uint8Array, name = 'bom.xlsx') =>
        fetch(`${base}/api/uploads?kind=bom`, { method: 'POST', headers: { cookie: cookieHeader(sess) }, body: form(data, name) })
      expect((await upBom(tech, new TextEncoder().encode('%PDF-1.4\n'), 'a.xlsx')).status).toBe(400)
      const preview = (sess: Record<string, string>) =>
        fetch(`${base}/api/bom/excel`, { method: 'POST', headers: { cookie: cookieHeader(sess) }, body: form(xlsx, 'bom.xlsx', { workOrderNumber: MINE }) })
      expect((await preview(proc)).status).toBe(403) // 工艺部不能发图纸
      expect((await preview(prod)).status).toBe(403)
      const pv = await preview(tech)
      expect(pv.status).toBe(200)
      expect(await pv.json()).toMatchObject({ rows: 2, errors: [], blocking: 0, lines: [{ drawingNo: 'HTTP-BOM-1', status: 'new' }, { drawingNo: 'HTTP-BOM-2', status: 'new' }] })

      const procBom = ((await (await upBom(proc, xlsx)).json()) as { id: string }[])[0]!.id
      expect((await send(proc, 'POST', '/api/releases', { type: 'PROCESS', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'], bomFileId: procBom })).status).toBe(400)
      const [bf] = (await (await upBom(tech, xlsx)).json()) as { id: string; mime: string }[]
      expect(bf!.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      // 别人上传的 BOM 不能用
      expect((await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'], bomFileId: procBom })).status).toBe(400)
      // BOM 表不能当普通附件
      expect((await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'], attachmentIds: [bf!.id] })).status).toBe(400)
      const rel = await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: '车架图纸第一批', userIds: ['h-prod', 'h-proc'], bomFileId: bf!.id })
      expect(rel.status).toBe(200)
      const relBody = (await rel.json()) as { id: string; bom: { created: number } }
      expect(relBody.bom).toMatchObject({ created: 2, matched: 0 })
      // 工艺部签收时看到这批工件和 BOM 表，能下载
      const det = (await (await get(`/api/releases/${relBody.id}`, proc)).json()) as { bomFile: { url: string }; parts: { drawingNo: string; quantity: number }[] }
      expect(det.parts.map((p) => [p.drawingNo, p.quantity]).sort()).toEqual([['HTTP-BOM-1', 1], ['HTTP-BOM-2', 2]])
      const dl = await get(det.bomFile.url, proc)
      expect(dl.status).toBe(200)
      expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="BOM-[0-9a-f]{8}\.xlsx"$/)
      // 同一个文件不能再发
      expect((await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'], bomFileId: bf!.id })).status).toBe(400)
      // 表上写的工单号和选的不一样：预览标出来，发放拦下
      const wb2 = new ExcelJS.Workbook()
      wb2.addWorksheet('明细').addRows([['工单号：OTHER-WO-1'], ['代号', '名称', '张数'], ['HTTP-BOM-9', '接口吊耳', 2]])
      const wrong = new Uint8Array(await wb2.xlsx.writeBuffer())
      const pv2 = await fetch(`${base}/api/bom/excel`, { method: 'POST', headers: { cookie: cookieHeader(tech) }, body: form(wrong, 'w.xlsx', { workOrderNumber: MINE }) })
      expect(await pv2.json()).toMatchObject({ sheetWorkOrder: 'OTHER-WO-1', workOrderMismatch: true, lines: [{ drawingNo: 'HTTP-BOM-9', quantity: 1, status: 'new' }] })
      const [wf] = (await (await upBom(tech, wrong)).json()) as { id: string }[]
      const bad = await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-prod'], bomFileId: wf!.id })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { message: string }).message).toContain('工单号是 OTHER-WO-1')
      // 没有 Excel：粘贴明细（10-24 zhao 技术部只有纸质明细表）→ 预览行号对上粘贴内容 → save 存成 BOM 表 → 发放建工件
      const paste = (sess: Record<string, string>, text: string, save = false) => send(sess, 'POST', '/api/bom/text', { workOrderNumber: MINE, text, save })
      expect((await paste(proc, 'HTTP-BOM-5 接口销轴 4')).status).toBe(403)
      const pt = await paste(tech, 'HTTP-BOM-5 接口销轴 4\n\nHTTP-BOM-6 接口连接板 x')
      expect(pt.status).toBe(200)
      expect(await pt.json()).toMatchObject({ rows: 2, errors: [{ row: 3, messages: [expect.stringContaining('数量"x"')] }] })
      expect((await paste(tech, 'HTTP-BOM-5 接口销轴 4\n\nHTTP-BOM-6 接口连接板 x', true)).status).toBe(400) // 有错不存
      const ok = await paste(tech, '代号\t名称\t数量\nHTTP-BOM-5\t接口销轴\t4\nHTTP-BOM-1\t接口主梁\t1', true)
      expect(ok.status).toBe(200)
      const okBody = (await ok.json()) as { fileId: string; lines: { drawingNo: string; status: string }[] }
      expect(okBody.lines.map((l) => [l.drawingNo, l.status])).toEqual([['HTTP-BOM-5', 'new'], ['HTTP-BOM-1', 'exists']])
      const rel2 = await send(tech, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: '车架图纸第二批', userIds: ['h-prod'], bomFileId: okBody.fileId })
      expect(rel2.status).toBe(200)
      expect(((await rel2.json()) as { bom: unknown }).bom).toMatchObject({ created: 1, matched: 1 })
    }
    expect(await me(qa)).toMatchObject({ businessDept: 'QUALITY', menu: ['deptPlan', 'production'], can: { route: false, mobileSend: false } })
    expect(await me(pm)).toMatchObject({ menu: ['tech', 'process', 'purchase', 'production'], pmOf: [MINE], can: { overview: false } })
    expect(await me(lead)).toMatchObject({ menu: ['overview', 'deptPlan', 'tech', 'process', 'purchase', 'production'], can: { overview: true, seeAmount: true } })

    // 主数据用户：department 仍是 QMS 原名称（给人看），businessDept 是换算出的编码（选人下拉按它排序）
    const master = (await (await get('/api/master', pm)).json()) as { users: { id: string; department: string; businessDept: string | null }[] }
    const mu = (id: string) => master.users.find((u) => u.id === id)
    expect(mu('h-tech')).toMatchObject({ department: '技术科', businessDept: 'TECH' })
    expect(mu('h-buyer')).toMatchObject({ department: '采购一组', businessDept: 'PURCHASE' })
    expect(mu('h-prod')).toMatchObject({ department: '生产部', businessDept: 'PRODUCTION' })
    expect(mu('h-qa')).toMatchObject({ department: '检验科', businessDept: 'QUALITY' })
    expect(mu('h-pm')).toMatchObject({ department: '', businessDept: null })

    // 工件：生产部任何工单都能建；项目经理只能在自己的工单；质量部、技术部只读
    await db.qmsProcess.upsert({ where: { id: 'T-PRC-R13' }, update: {}, create: { id: 'T-PRC-R13', name: '组焊', updatedAt: new Date() } })
    const prodPart = await send(prod, 'POST', '/api/parts', { workOrderNumber: OTHER, name: 'R13 生产建的', quantity: 1 })
    expect(prodPart.status).toBe(200)
    const qaDenied = await send(qa, 'POST', '/api/parts', { workOrderNumber: MINE, name: 'x', quantity: 1 })
    expect(qaDenied.status).toBe(403)
    expect(((await qaDenied.json()) as { message: string }).message).toBe('只有生产部、工艺部、外协专员、该工单项目经理或管理员可以修改工件和工序')
    expect((await send(tech, 'POST', '/api/parts', { workOrderNumber: MINE, name: 'x', quantity: 1 })).status).toBe(403)
    const pmPart = await send(pm, 'POST', '/api/parts', { workOrderNumber: MINE, name: 'R13 项目经理建的', quantity: 1 })
    expect(pmPart.status).toBe(200)
    const partId = ((await pmPart.json()) as { id: string }).id
    expect((await send(qa, 'PATCH', `/api/parts/${partId}`, { name: 'x' })).status).toBe(403)

    // 工序：项目经理在自己的工单上加；责任人是质检员
    const step = await send(pm, 'POST', `/api/parts/${partId}/steps`, { processId: 'T-PRC-R13', mode: 'SELF', ownerId: 'h-qa' })
    expect(step.status).toBe(200)
    const stepId = (await db.routeStep.findFirstOrThrow({ where: { partId }, select: { id: true } })).id
    // 改工序：责任人本人也不行（只能开工完工）；项目经理可以
    expect((await send(qa, 'PATCH', `/api/steps/${stepId}`, { ownerId: 'h-qa' })).status).toBe(403)
    expect((await send(qa, 'POST', `/api/steps/${stepId}/move`, { direction: 'up' })).status).toBe(403)
    expect((await send(pm, 'PATCH', `/api/steps/${stepId}`, { ownerId: 'h-qa' })).status).toBe(200)

    // 开工 / 完工：项目经理、技术员不行；工序责任人本人可以；生产部可以
    const startDenied = await send(pm, 'POST', `/api/steps/${stepId}/start`, {})
    expect(startDenied.status).toBe(403)
    expect(((await startDenied.json()) as { message: string }).message).toBe('只有生产部、外协专员、该工序责任人、本班组班组长（自制工序的开工、完工、报工）或管理员可以登记开工、完工、发出、返厂')
    expect((await send(tech, 'POST', `/api/steps/${stepId}/start`, {})).status).toBe(403)
    expect((await send(qa, 'POST', `/api/steps/${stepId}/start`, {})).status).toBe(200)
    expect((await send(prod, 'POST', `/api/steps/${stepId}/finish`, {})).status).toBe(200)

    // 领导总览：领导、管理员可调；其他人 403（项目经理、项目部以外的部门）
    expect((await get('/api/overview', qa)).status).toBe(403)
    expect((await get('/api/overview', pm)).status).toBe(403)
    const ov = await get('/api/overview', lead)
    expect(ov.status).toBe(200)
    const overview = (await ov.json()) as { summary: Record<string, number>; stages: { key: string; count: number }[]; byDept: unknown[]; redWorkOrders: unknown[] }
    expect(Object.keys(overview.summary).sort()).toEqual(['closedIssues', 'green', 'newIssues', 'overdueIssues', 'red', 'yellow'])
    expect(overview.stages.map((x) => x.key)).toEqual(['drawing', 'shortage', 'outsource', 'kitting', 'issue'])
    expect((await get('/api/overview', admin)).status).toBe(200)

    // 部门对照设置：仅管理员；改了立即生效；"不对应"删掉对照后回到按名称
    expect((await send(lead, 'PUT', '/api/settings/dept-mappings/T-DEPT-PROD', { businessDept: 'QUALITY' })).status).toBe(403)
    expect((await send(admin, 'PUT', '/api/settings/dept-mappings/T-NOPE', { businessDept: 'QUALITY' })).status).toBe(400)
    expect((await send(admin, 'PUT', '/api/settings/dept-mappings/T-DEPT-PROD', { businessDept: 'QUALITY' })).status).toBe(200)
    expect((await me(await login('h-prod'))).businessDept).toBe('QUALITY')
    expect((await send(admin, 'PUT', '/api/settings/dept-mappings/T-DEPT-PROD', { businessDept: null })).status).toBe(200)
    expect((await me(await login('h-prod'))).businessDept).toBe('PRODUCTION')
    const settings = (await (await get('/api/settings', admin)).json()) as {
      departments: string[]
      deptsWithoutHead: string[]
      qmsDepartments: { id: string; parentName: string | null; level: number; businessDept: string | null; effective: string | null }[]
    }
    expect(settings.departments).toEqual(['技术部', '工艺部', '采购部', '生产部', '质量部', '财务部', '项目部'])
    expect(settings.qmsDepartments.find((d) => d.id === 'T-DEPT-BUY1')).toMatchObject({ parentName: '供应部', level: 1, businessDept: null, effective: '采购部' })
    // 部门负责人只能选 7 个业务部门
    expect((await send(admin, 'POST', '/api/settings/roles', { role: 'DEPT_HEAD', userId: 'h-qa', department: '检验科' })).status).toBe(400)
  })

  it('总计划 R14：编辑限该工单项目经理 / 项目部 / 管理员；模板限项目部负责人 / 管理员；确认限责任部门负责人；手动完成限责任部门 / 项目经理；发布后挂节点必选', async () => {
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const pm = await login('h-pm')
    const buyer = await login('h-buyer')
    const tech = await login('h-tech')
    const prodHead = await login('h-worker') // 上面 R12 用例里设成了生产部负责人
    const admin = await login('h-admin')
    const later = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

    // 模板：项目经理 403；管理员可以
    const tpl = { name: 'HTTP 测试模板', nodes: [{ name: '设计', dept: 'TECH', daysBeforeDelivery: 30 }] }
    expect((await send(pm, 'POST', '/api/plan/templates', tpl)).status).toBe(403)
    const created = await send(admin, 'POST', '/api/plan/templates', tpl)
    expect(created.status).toBe(200)
    const tplId = ((await created.json()) as { id: string }).id
    expect((await send(pm, 'PUT', `/api/plan/templates/${tplId}`, tpl)).status).toBe(403)
    expect((await send(pm, 'DELETE', `/api/plan/templates/${tplId}`)).status).toBe(403)
    expect((await send(admin, 'DELETE', `/api/plan/templates/${tplId}`)).status).toBe(200)
    const me = (await (await get('/api/me', admin)).json()) as { can: Record<string, boolean> }
    expect(me.can).toMatchObject({ plan: true, planTemplate: true })

    // 生成：采购员 403；项目经理别人的工单 403（看不到），自己的工单 200
    const gen = { workOrderNumber: MINE, templateId: 'plan-tpl-generic' }
    expect((await send(buyer, 'POST', '/api/plan/generate', gen)).status).toBe(403)
    expect((await send(pm, 'POST', '/api/plan/generate', { ...gen, workOrderNumber: OTHER })).status).toBe(403)
    expect((await send(pm, 'POST', '/api/plan/generate', gen)).status).toBe(200)
    // 能看到工单就能看总计划
    expect((await get(`/api/plan?workOrderNumber=${MINE}`, buyer)).status).toBe(200)
    expect((await get(`/api/plan?workOrderNumber=${OTHER}`, pm)).status).toBe(403)
    expect((await send(tech, 'POST', '/api/plan/publish', { workOrderNumber: MINE })).status).toBe(403)
    expect((await send(pm, 'POST', '/api/plan/publish', { workOrderNumber: MINE })).status).toBe(200)
    const view = (await (await get(`/api/plan?workOrderNumber=${MINE}`, pm)).json()) as { canEdit: boolean; nodes: { id: string; name: string; dept: string }[] }
    expect(view.canEdit).toBe(true)
    const design = view.nodes.find((n) => n.name === '设计出图')!
    const cut = view.nodes.find((n) => n.name === '下料组焊')!
    const buy = view.nodes.find((n) => n.name === '关键物料到货')!

    // 发布后改日期：没原因 400；采购员改不了 403
    const noReason = await send(pm, 'PATCH', `/api/plan/nodes/${design.id}`, { planDate: later(20) })
    expect(noReason.status).toBe(400)
    expect(((await noReason.json()) as { message: string }).message).toContain('调整原因')
    expect((await send(buyer, 'PATCH', `/api/plan/nodes/${design.id}`, { planDate: later(20), reason: 'x' })).status).toBe(403)
    expect((await send(pm, 'PATCH', `/api/plan/nodes/${design.id}`, { planDate: later(20), reason: '客户提前要图' })).status).toBe(200)
    expect((await send(buyer, 'DELETE', `/api/plan/nodes/${design.id}`, { reason: 'x' })).status).toBe(403)
    expect((await send(buyer, 'POST', '/api/plan/nodes', { workOrderNumber: MINE, name: 'x', dept: 'TECH', planDate: later(20), reason: 'x' })).status).toBe(403)

    // 确认：项目经理、技术部普通员工 403；生产部负责人确认生产部节点 200、技术部节点 403；管理员 200
    expect((await send(pm, 'POST', `/api/plan/nodes/${design.id}/confirm`, {})).status).toBe(403)
    expect((await send(tech, 'POST', `/api/plan/nodes/${design.id}/confirm`, {})).status).toBe(403)
    expect((await send(prodHead, 'POST', `/api/plan/nodes/${design.id}/confirm`, {})).status).toBe(403)
    expect((await send(prodHead, 'POST', `/api/plan/nodes/${cut.id}/confirm`, {})).status).toBe(200)
    expect((await send(admin, 'POST', `/api/plan/nodes/${design.id}/confirm`, {})).status).toBe(200)
    expect((await send(buyer, 'POST', `/api/plan/nodes/${buy.id}/reject`, { reason: '排不过来' })).status).toBe(403)
    expect((await send(admin, 'POST', `/api/plan/nodes/${buy.id}/reject`, { reason: '' })).status).toBe(400)

    // 手动完成：别的部门 403；本部门员工、项目经理可以
    expect((await send(buyer, 'POST', `/api/plan/nodes/${design.id}/complete`, {})).status).toBe(403)
    expect((await send(tech, 'POST', `/api/plan/nodes/${design.id}/complete`, {})).status).toBe(200)
    expect((await send(buyer, 'POST', `/api/plan/nodes/${design.id}/undo-complete`, {})).status).toBe(403)
    expect((await send(pm, 'POST', `/api/plan/nodes/${design.id}/undo-complete`, {})).status).toBe(200)

    // 已发布：新建设计任务必须选节点（400）；选了别的工单的节点 400；选对了 200
    const noNode = await send(tech, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: 'R14 图', planDate: later(15) })
    expect(noNode.status).toBe(400)
    expect(((await noNode.json()) as { message: string }).message).toContain('请选择所属总计划节点')
    const ok = await send(tech, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: 'R14 图', planDate: later(25), planNodeId: design.id })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { planWarning: string | null }).planWarning).toContain('晚于总计划节点')
    const opts = (await (await get(`/api/plan/options?workOrderNumber=${MINE}`, tech)).json()) as { published: boolean; nodes: unknown[] }
    expect(opts.published).toBe(true)
    expect(opts.nodes).toHaveLength(11)
    expect((await get(`/api/plan/options?workOrderNumber=${OTHER}`, pm)).status).toBe(403)

    // 部门计划二次分解：其他任务建 / 改 / 删限责任部门的人、项目经理、项目部、管理员；负责人本人能标完成；挂工序按编辑工序的权限
    expect((await send(buyer, 'POST', `/api/plan/nodes/${design.id}/tasks`, { name: '越权分解', ownerId: 'h-buyer', planDate: later(10) })).status).toBe(403)
    expect((await send(tech, 'POST', `/api/plan/nodes/${design.id}/tasks`, { name: '', ownerId: 'h-buyer', planDate: later(10) })).status).toBe(400)
    const made = await send(tech, 'POST', `/api/plan/nodes/${design.id}/tasks`, { name: '工艺文件', ownerId: 'h-buyer', planDate: later(10) })
    expect(made.status).toBe(200)
    const taskId = ((await made.json()) as { id: string }).id
    expect((await send(buyer, 'PATCH', `/api/plan/tasks/${taskId}`, { name: '改名' })).status).toBe(403)
    expect((await send(pm, 'PATCH', `/api/plan/tasks/${taskId}`, { name: '工艺文件编制' })).status).toBe(200)
    const buyerTodos = (await (await get('/api/todos', buyer)).json()) as { action: string; planTask: { id: string } | null }[]
    expect(buyerTodos.find((t) => t.action === 'DO_PLAN_TASK')?.planTask?.id).toBe(taskId)
    expect((await send(buyer, 'POST', `/api/plan/tasks/${taskId}/complete`, {})).status).toBe(200)
    expect((await send(buyer, 'POST', `/api/plan/tasks/${taskId}/undo-complete`, {})).status).toBe(200)
    expect((await send(buyer, 'DELETE', `/api/plan/tasks/${taskId}`)).status).toBe(403)
    expect((await send(tech, 'DELETE', `/api/plan/tasks/${taskId}`)).status).toBe(200)
    expect((await get(`/api/plan/nodes/${cut.id}/steps`, pm)).status).toBe(200)
    expect((await get(`/api/plan/nodes/${cut.id}/steps`, buyer)).status).toBe(403)
    // 项目计划一览：只列看得到的工单
    const listed = (await (await get('/api/plan/list', pm)).json()) as { rows: { workOrderNumber: string }[] }
    expect(listed.rows.map((x) => x.workOrderNumber)).toContain(MINE)
    expect(listed.rows.map((x) => x.workOrderNumber)).not.toContain(OTHER)
    expect((await send(pm, 'POST', `/api/plan/nodes/${cut.id}/steps`, { stepIds: [] })).status).toBe(400)
    expect((await send(buyer, 'POST', `/api/plan/nodes/${cut.id}/steps`, { stepIds: ['x'] })).status).toBe(403)
  })
  it('工单详情（前端改版第一轮）：可见工单返回总计划节点 + 挂节点记录 + 未挂计数，不含金额；项目经理看别人的工单 403；不存在 404；列表带总计划节点', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const admin = await login('h-admin')
    const tech = await login('h-tech')
    // 上面 R14 用例：MINE 已按通用模板发布（11 个节点），"R14 图"挂在"设计出图"上；再加一条没挂节点的采购行
    await db.purchaseLine.create({ data: { workOrderNumber: MINE, materialName: '详情未挂物料', quantity: 1, needDate: new Date('2026-11-20') } })

    const res = await get(`/api/work-orders/${MINE}/detail`, pm)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('"amount"')
    const d = JSON.parse(text) as {
      today: string
      published: boolean
      workOrder: { workOrderNumber: string; deliveryDate: string; projectManagerName: string | null }
      progress: { total: number; done: number }
      nodes: { id: string; name: string; state: string; planDate: string; tasks: { kind: string; name: string; link: string }[] }[]
      unlinked: { drawing: number; purchase: number; step: number; assembly: number }
      issues: { open: number }
      actions: unknown[]
      expectedDelivery: string | null
    }
    expect(d.published).toBe(true)
    expect(d.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(d.workOrder).toMatchObject({ workOrderNumber: MINE, deliveryDate: '2026-12-31' })
    expect(d.workOrder.projectManagerName).toBeTruthy()
    expect(d.nodes).toHaveLength(11)
    expect(d.progress.total).toBe(11)
    expect(d.expectedDelivery).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const n of d.nodes) expect(['DONE', 'SOURCE', 'UPSTREAM', 'ON_TRACK']).toContain(n.state)
    const design = d.nodes.find((n) => n.name === '设计出图')!
    expect(design.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'drawing', name: 'R14 图', link: `/drawings?wo=${MINE}&view=all` })]))
    // 未挂节点数与库里一致（已取消的不算）
    const [drawing, purchase, step, assembly] = await Promise.all([
      db.drawingTask.count({ where: { workOrderNumber: MINE, planNodeId: null, status: { not: 'CANCELLED' } } }),
      db.purchaseLine.count({ where: { workOrderNumber: MINE, planNodeId: null, status: { not: 'CANCELLED' } } }),
      db.routeStep.count({ where: { part: { workOrderNumber: MINE }, planNodeId: null } }),
      db.assemblyNode.count({ where: { workOrderNumber: MINE, planNodeId: null } }),
    ])
    expect(d.unlinked).toMatchObject({ drawing, purchase, step, assembly })
    expect(purchase).toBeGreaterThanOrEqual(1)
    expect(d.issues.open).toBe(await db.issue.count({ where: { workOrderNumber: MINE, status: { in: ['OPEN', 'ACCEPTED', 'RESOLVED'] } } }))

    // 只当项目经理的人看别人的工单：403；不在范围内的不存在工单也是 403（不泄露是否存在）
    expect((await get(`/api/work-orders/${OTHER}/detail`, pm)).status).toBe(403)
    expect((await get('/api/work-orders/NO-SUCH-WO/detail', pm)).status).toBe(403)
    // 看全部的人：别人的工单 200（没有总计划：节点为空）；不存在 404
    const other = (await (await get(`/api/work-orders/${OTHER}/detail`, lead)).json()) as { plan: unknown; nodes: unknown[]; published: boolean }
    expect(other).toMatchObject({ plan: null, nodes: [], published: false })
    expect((await get('/api/work-orders/NO-SUCH-WO/detail', admin)).status).toBe(404)
    // 未登录 401
    expect((await fetch(`${base}/api/work-orders/${MINE}/detail`)).status).toBe(401)

    // 项目总览（看板）加的字段：节点摘要、是否有总计划
    const board = (await (await get('/api/board', pm)).json()) as { rows: { workOrderNumber: string; hasPlan: boolean; planNodes: unknown[] }[]; sourceByDept: unknown[] }
    expect(board.rows.find((r) => r.workOrderNumber === MINE)).toMatchObject({ hasPlan: true })
    expect(board.rows.find((r) => r.workOrderNumber === MINE)!.planNodes).toHaveLength(11)
    expect(Array.isArray(board.sourceByDept)).toBe(true)
    // 设计 / 采购列表的"总计划节点"列
    const drawings = (await (await get(`/api/drawings?workOrderNumber=${MINE}&view=all`, tech)).json()) as { rows: { componentName: string; planNode: { id: string; seq: number; name: string } | null }[] }
    expect(drawings.rows.find((r) => r.componentName === 'R14 图')!.planNode).toMatchObject({ id: design.id, name: '设计出图' })
    const lines = (await (await get(`/api/purchases?workOrderNumber=${MINE}&view=all`, admin)).json()) as { rows: { materialName: string; planNode: unknown }[] }
    expect(lines.rows.find((r) => r.materialName === '详情未挂物料')!.planNode).toBeNull()
  })

  it('前端改版第二轮：未读提醒数只数本人的、与提醒列表同一口径；提醒 / 待办带工作台分组；各页统计卡与对应筛选同一口径', async () => {
    const pm = await login('h-pm')
    const pm2 = await login('h-pm2')
    const lead = await login('h-lead')
    const admin = await login('h-admin')
    const json = async <T>(path: string, s: Record<string, string>) => {
      const r = await get(path, s)
      expect(r.status, path).toBe(200)
      return (await r.json()) as T
    }

    // ── 未读提醒数（菜单角标）：只数本人的；标已读后减少；未登录 401 ──
    await db.reminder.deleteMany({ where: { userId: { in: ['h-pm', 'h-pm2'] } } })
    const [r1] = await Promise.all([
      db.reminder.create({ data: { userId: 'h-pm', title: '总计划节点被退回', level: 'YELLOW', kind: 'PLAN', link: `/plan?wo=${MINE}&node=x` } }),
      db.reminder.create({ data: { userId: 'h-pm', title: '普通提醒', level: 'REMIND' } }),
      db.reminder.create({ data: { userId: 'h-pm', title: '已读的', level: 'RED', readAt: new Date() } }),
      db.reminder.create({ data: { userId: 'h-pm2', title: '别人的', level: 'RED' } }),
    ])
    expect(await json('/api/reminders/unread-count', pm)).toEqual({ unread: 2, planPending: 0 })
    expect(await json('/api/reminders/unread-count', pm2)).toEqual({ unread: 1, planPending: 0 })
    const list = await json<{ unread: number; items: { id: string; workOrderNumber: string | null; dueDay: string | null; bucket: string }[] }>('/api/reminders', pm)
    expect(list.unread).toBe(2)
    // 总计划退回通知：工单从跳转地址取；没有截止日的不论级别都归"未定截止日"
    expect(list.items.find((i) => i.id === r1.id)).toMatchObject({ workOrderNumber: MINE, dueDay: null, bucket: 'NO_DUE' })
    expect(list.items.map((i) => i.bucket)).toEqual(['NO_DUE', 'NO_DUE', 'NO_DUE'])
    const read = await fetch(`${base}/api/reminders/${r1.id}/read`, { method: 'POST', headers: { cookie: cookieHeader(pm) } })
    expect(read.status).toBe(200)
    expect(await json('/api/reminders/unread-count', pm)).toEqual({ unread: 1, planPending: 0 })
    expect((await fetch(`${base}/api/reminders/unread-count`)).status).toBe(401)
    // 待办也带分组字段
    const todos = await json<{ bucket: string; workOrderNumber: string | null }[]>('/api/todos', admin)
    for (const t of todos) expect(['OVERDUE', 'TODAY', 'WEEK', 'LATER', 'NO_DUE']).toContain(t.bucket)

    // ── 风险页：预警带责任部门，异常带换算后的业务部门 ──
    const buyIssue = await db.issue.create({
      data: { issueNo: `YC-T2-${Date.now()}`, workOrderNumber: MINE, category: 'OTHER', description: '第二轮部门', source: 'MANUAL', reporterId: 'h-pm', responsibleDeptId: 'T-DEPT-BUY1' },
    })
    const issues = await json<{ id: string; deptGroup: string | null }[]>('/api/issues?dept=0', pm)
    expect(issues.find((i) => i.id === buyIssue.id)!.deptGroup).toBe(BUSINESS_DEPT_NAME.PURCHASE)
    for (const a of await json<{ deptNames: string[] }[]>('/api/alerts', lead)) expect(Array.isArray(a.deptNames)).toBe(true)

    // ── 发放签收统计：与列表筛选同一口径，范围与列表一致（项目经理只数自己的） ──
    for (const s of [pm, lead]) {
      const st = await json<{ all: number; pending: number; rejected: number; minePending: number }>('/api/releases/stats', s)
      expect(st.all).toBe((await json<unknown[]>('/api/releases', s)).length)
      expect(st.pending).toBe((await json<unknown[]>('/api/releases?progress=PENDING', s)).length)
      expect(st.rejected).toBe((await json<unknown[]>('/api/releases?progress=REJECTED', s)).length)
      expect(st.minePending).toBe((await json<unknown[]>('/api/releases?progress=MINE_PENDING', s)).length)
    }
    const leadAll = (await json<{ all: number }>('/api/releases/stats', lead)).all
    expect(leadAll).toBeGreaterThanOrEqual((await json<{ all: number }>('/api/releases/stats', pm)).all)

    // ── 付款统计：与状态筛选同一口径；项目经理只数自己的，查别人的工单 403 ──
    await db.paymentRequest.create({ data: { workOrderNumber: OTHER, amount: 10, requestDate: new Date('2026-10-01'), blocksDelivery: true, requesterId: 'h-pm2' } })
    for (const s of [pm, lead]) {
      const st = await json<{ pending: number; onHold: number; paid: number; blockingUnpaid: number }>('/api/payments/stats', s)
      expect(st.pending).toBe((await json<unknown[]>('/api/payments?status=PENDING', s)).length)
      expect(st.onHold).toBe((await json<unknown[]>('/api/payments?status=ON_HOLD', s)).length)
      expect(st.paid).toBe((await json<unknown[]>('/api/payments?status=PAID', s)).length)
      expect(st.blockingUnpaid).toBe((await json<unknown[]>('/api/payments?status=UNPAID&blocking=1', s)).length)
    }
    expect((await json<{ blockingUnpaid: number }>(`/api/payments/stats?workOrderNumber=${OTHER}`, lead)).blockingUnpaid).toBeGreaterThanOrEqual(1)
    expect((await get(`/api/payments/stats?workOrderNumber=${OTHER}`, pm)).status).toBe(403)

    // ── 设计"本周到期"、采购"卡付款"、齐套"需求日临近"：统计数字 = 对应筛选的条数 ──
    const d = await json<{ total: number; stats: { dueThisWeek: number } }>(`/api/drawings?view=week`, admin)
    expect(d.total).toBe(d.stats.dueThisWeek)
    const p = await json<{ total: number; stats: { blockedByPayment: number } }>(`/api/purchases?view=blocked`, admin)
    expect(p.total).toBe(p.stats.blockedByPayment)
    const k = await json<{ total: number; stats: { dueSoon: number } }>(`/api/kitting?dueSoon=1`, admin)
    expect(k.total).toBe(k.stats.dueSoon)

    await db.reminder.deleteMany({ where: { userId: { in: ['h-pm', 'h-pm2'] } } })
  })
  it('第二批（10-26）：留言、工件时间线、车间看板、全局搜索都按工单可见范围拦', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const post = (sess: Record<string, string>, body: object) =>
      fetch(`${base}/api/comments`, { method: 'POST', headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await get(`/api/comments?refType=part&refId=${otherPartId}`, pm)).status).toBe(403)
    expect((await post(pm, { refType: 'part', refId: otherPartId, body: '偷看' })).status).toBe(403)
    expect((await post(lead, { refType: 'part', refId: otherPartId, body: '请抓紧', mentionIds: ['h-worker'] })).status).toBe(200)
    const list = (await (await get(`/api/comments?refType=part&refId=${otherPartId}`, lead)).json()) as { body: string }[]
    expect(list.map((c) => c.body)).toEqual(['请抓紧'])
    expect((await get(`/api/parts/${otherPartId}/timeline`, pm)).status).toBe(403)
    expect((await get(`/api/parts/${otherPartId}/timeline`, lead)).status).toBe(200)
    expect((await get(`/api/workshop?wo=${OTHER}`, pm)).status).toBe(403)
    expect((await get('/api/workshop', pm)).status).toBe(200)
    const hits = (await (await get(`/api/search?q=${encodeURIComponent('别人的工件')}`, pm)).json()) as unknown[]
    expect(hits).toEqual([])
    const leadHits = (await (await get(`/api/search?q=${encodeURIComponent('别人的工件')}`, lead)).json()) as { type: string }[]
    expect(leadHits.map((h) => h.type)).toEqual(['part'])
    await db.comment.deleteMany({ where: { refId: otherPartId } })
    await db.reminder.deleteMany({ where: { kind: 'COMMENT' } })
  })
  it('班组长（生产管理重设计第二批）：只能登记本班组自制工序的开工、完工、报工；别的班组、外协工序、改工序都不行；班组长只有生产部 / 管理员能设', async () => {
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const TEAMS = ['H-TEAM-A', 'H-TEAM-B', 'H-OUT']
    const clean = async () => {
      const parts = await db.part.findMany({ where: { workOrderNumber: MINE, name: { startsWith: '班组长测试' } }, select: { id: true } })
      await db.flowEvent.deleteMany({ where: { step: { partId: { in: parts.map((p) => p.id) } } } })
      await db.todo.deleteMany({ where: { refId: { in: parts.map((p) => p.id) } } })
      await db.part.deleteMany({ where: { id: { in: parts.map((p) => p.id) } } })
      await db.qmsSupplier.deleteMany({ where: { id: { in: TEAMS } } }) // 班组长级联删除
      await db.qmsProcess.deleteMany({ where: { id: 'H-PRC' } })
    }
    await clean()
    const now = new Date()
    await db.qmsSupplier.createMany({
      data: [
        { id: 'H-TEAM-A', name: '甲班', kind: 'TEAM', updatedAt: now },
        { id: 'H-TEAM-B', name: '乙班', kind: 'TEAM', updatedAt: now },
        { id: 'H-OUT', name: '外协厂', updatedAt: now },
      ],
    })
    await db.qmsProcess.create({ data: { id: 'H-PRC', name: '下料', supplierSource: 'Supplier', updatedAt: now } })
    const part = async (name: string, step: { mode: 'SELF' | 'IN_PLANT_OUTSOURCE' | 'EXTERNAL_OUTSOURCE'; supplierId: string }) => {
      const p = await db.part.create({ data: { workOrderNumber: MINE, name: `班组长测试 ${name}`, quantity: 2 } })
      return db.routeStep.create({ data: { partId: p.id, seq: 1, processId: 'H-PRC', ...step } })
    }
    const own = await part('本班自制', { mode: 'SELF', supplierId: 'H-TEAM-A' })
    const other = await part('别班自制', { mode: 'SELF', supplierId: 'H-TEAM-B' })
    const inPlant = await part('本班厂内外协', { mode: 'IN_PLANT_OUTSOURCE', supplierId: 'H-TEAM-A' })

    const leader = await login('h-leader')
    const prod = await login('h-prod')
    // 还不是班组长：只读；自己不能给自己设班组长
    expect((await send(leader, 'POST', `/api/steps/${own.id}/start`, { source: 'MOBILE' })).status).toBe(403)
    expect((await send(leader, 'PUT', '/api/team-leaders/H-TEAM-A', { userId: 'h-leader' })).status).toBe(403)
    // 生产部设班组长；同步不碰（见 sync.test.ts）
    expect((await send(prod, 'PUT', '/api/team-leaders/H-TEAM-A', { userId: 'h-leader' })).status).toBe(200)
    expect((await send(prod, 'PUT', '/api/team-leaders/H-OUT', { userId: 'h-leader' })).status).toBe(400) // 外协厂不是班组
    const list = (await (await get('/api/team-leaders', leader)).json()) as { teamId: string; leaderId: string | null }[]
    expect(list.find((t) => t.teamId === 'H-TEAM-A')).toMatchObject({ leaderId: 'h-leader' })

    const me = (await (await get('/api/me', leader)).json()) as { menu: string[]; can: Record<string, boolean>; leadTeams: { id: string }[] }
    expect(me.leadTeams.map((t) => t.id)).toEqual(['H-TEAM-A'])
    expect(me.menu).toContain('production')
    expect(me.can).toMatchObject({ stepAction: false, route: false, teamLeader: false })

    // 本班组自制：开工、部分完工（报工）、完工
    expect((await send(leader, 'POST', `/api/steps/${own.id}/start`, { source: 'MOBILE' })).status).toBe(200)
    expect((await send(leader, 'POST', `/api/steps/${own.id}/finish`, { source: 'MOBILE', qty: 1, rest: 'CONTINUE' })).status).toBe(200)
    expect((await send(leader, 'POST', `/api/steps/${own.id}/finish`, { source: 'MOBILE' })).status).toBe(200)
    // 别的班组、厂内外协（supplierId 也是本班，但不是自制）、改工序：403
    expect((await send(leader, 'POST', `/api/steps/${other.id}/start`, { source: 'MOBILE' })).status).toBe(403)
    expect((await send(leader, 'POST', `/api/steps/${inPlant.id}/start`, { source: 'MOBILE' })).status).toBe(403)
    expect((await send(leader, 'PATCH', `/api/steps/${other.id}`, { ownerId: 'h-leader' })).status).toBe(403)

    // "我的"：本班组的自制工序（没指定负责人也算）；别的班组的不在
    const mine = (await (await get(`/api/production?wo=${MINE}&mine=1`, leader)).json()) as { rows: { stepId: string; leaderId: string | null }[] }
    expect(mine.rows.map((r) => r.stepId)).toEqual([own.id])
    const all = (await (await get(`/api/production?wo=${MINE}`, leader)).json()) as { rows: { stepId: string; leaderId: string | null }[] }
    expect(all.rows.find((r) => r.stepId === other.id)).toMatchObject({ leaderId: null })

    // 清除班组长后又变回只读
    // （用本班组一道新的待开工工序验证：原班组长对本班组的活也不能再开工）
    const fresh = await part('本班自制·清除后', { mode: 'SELF', supplierId: 'H-TEAM-A' })
    expect((await send(prod, 'PUT', '/api/team-leaders/H-TEAM-A', { userId: null })).status).toBe(200)
    expect((await send(leader, 'POST', `/api/steps/${fresh.id}/start`, { source: 'MOBILE' })).status).toBe(403)
    expect((await send(leader, 'POST', `/api/steps/${other.id}/start`, { source: 'MOBILE' })).status).toBe(403)
    await clean()
  })
  it('采购计划：技术部建/下发、采购部转入；写权限与工单范围在接口拦截', async () => {
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) => fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const tech = await login('h-tech')
    const buyer = await login('h-buyer')
    const pm = await login('h-pm')
    const body = { workOrderNumber: OTHER, title: 'HTTP采购计划', category: '主要外购件' }
    // 本用例不依赖其他用例发布的总计划状态。
    await db.workOrderPlan.deleteMany({ where: { workOrderNumber: OTHER } })
    expect((await send(buyer, 'POST', '/api/purchase-plans', body)).status).toBe(403)
    const created = await send(tech, 'POST', '/api/purchase-plans', body)
    expect(created.status).toBe(200)
    const p = await created.json() as { id: string }
    try {
      const added = await send(tech, 'POST', `/api/purchase-plans/${p.id}/items`, { materialName: 'HTTP电机', quantity: 1, needDate: '2026-12-01' })
      expect(added.status).toBe(200)
      const item = await added.json() as { id: string }
      expect((await send(buyer, 'POST', `/api/purchase-plans/${p.id}/issue`)).status).toBe(403)
      expect((await send(tech, 'POST', `/api/purchase-plans/${p.id}/issue`)).status).toBe(200)
      expect((await send(tech, 'POST', `/api/purchase-plans/${p.id}/convert`, {})).status).toBe(403)
      expect((await get(`/api/purchase-plans/${p.id}`, pm)).status).toBe(403)
      expect((await send(pm, 'POST', `/api/purchase-plans/${p.id}/convert`, {})).status).toBe(403)
      const converted = await send(buyer, 'POST', `/api/purchase-plans/${p.id}/convert`, { itemIds: [item.id] })
      expect(converted.status).toBe(200)
      expect(await converted.json()).toMatchObject({ succeeded: 1, failed: 0 })
      const detail = await (await get(`/api/purchase-plans/${p.id}`, tech)).json() as { progress: object }
      expect(detail.progress).toMatchObject({ total: 1, converted: 1, arrived: 0 })
      const list = await (await get('/api/purchase-plans', pm)).json() as { rows: { id: string }[] }
      expect(list.rows.some(row => row.id === p.id)).toBe(false)
    } finally {
      await db.todo.deleteMany({ where: { refType: 'purchasePlan', refId: p.id } })
      const ids = (await db.purchasePlanItem.findMany({ where: { planId: p.id } })).flatMap(i => i.convertedLineId ? [i.convertedLineId] : [])
      await db.purchasePlan.delete({ where: { id: p.id } })
      await db.purchaseLine.deleteMany({ where: { id: { in: ids } } })
    }
  })

})
