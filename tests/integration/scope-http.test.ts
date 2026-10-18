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
  const HTTP_USERS = ['h-pm', 'h-pm2', 'h-lead', 'h-worker', 'h-fin']

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
    await db.qmsUser.deleteMany({ where: { id: { in: HTTP_USERS } } })
    await db.qmsUser.createMany({ data: HTTP_USERS.map((id) => ({ id, username: id, realName: id, status: 'ACTIVE', updatedAt: now })) })
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
    await db?.release.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.drawingTask.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.paymentRequest.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.purchaseLine.deleteMany({ where: { workOrderNumber: { in: [MINE, OTHER] } } })
    await db?.notifyRole.deleteMany({ where: { userId: 'h-fin' } })
    await db?.qmsUser.deleteMany({ where: { id: { in: HTTP_USERS } } })
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

  it('发放单（R9）：按工单可见范围新建/查看；接收人不受范围限制能看能签；只能签自己的；PDF 附件按发放单权限读取', async () => {
    const pm = await login('h-pm')
    const pm2 = await login('h-pm2')
    const worker = await login('h-worker')
    const post = (s: Record<string, string>, path: string, body: object) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookieHeader(s), 'content-type': 'application/json' }, body: JSON.stringify(body) })

    // 项目经理甲不能在别人的工单上发放
    expect((await post(pm, '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: 'x', userIds: ['h-worker'] })).status).toBe(403)

    // 附件：PDF 只能按附件传，按照片传 400
    const pdf = new TextEncoder().encode('%PDF-1.4\n%test\n')
    const upload = (kind: string) => {
      const form = new FormData()
      form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'drawing.pdf')
      return fetch(`${base}/api/uploads${kind ? `?kind=${kind}` : ''}`, { method: 'POST', headers: { cookie: cookieHeader(pm) }, body: form })
    }
    expect((await upload('')).status).toBe(400)
    const up = await upload('attachment')
    expect(up.status).toBe(200)
    const [att] = (await up.json()) as { id: string; mime: string; url: string }[]
    expect(att!.mime).toBe('application/pdf')

    // 甲在自己的工单上发给乙（乙看不到甲的工单）和一线
    const created = await post(pm, '/api/releases', { type: 'CHANGE', workOrderNumber: MINE, description: '孔位变更', userIds: ['h-pm2', 'h-worker'], attachmentIds: [att!.id] })
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
    const other = await post(lead, '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: '别的工单', userIds: ['h-worker'] })
    expect(other.status).toBe(200)
    const otherId = ((await other.json()) as { id: string }).id
    expect((await get(`/api/releases/${otherId}`, pm)).status).toBe(403)
    const list = (await (await get('/api/releases', pm)).json()) as { id: string }[]
    expect(list.some((r) => r.id === otherId)).toBe(false)
    expect(list.some((r) => r.id === id)).toBe(true)
    expect((await post(pm, `/api/releases/${otherId}/void`, {})).status).toBe(403)
    // 签收待办不能转交
    const todos = (await (await get('/api/todos', worker)).json()) as { id: string; action: string }[]
    const signTodo = todos.find((t) => t.action === 'SIGN_RELEASE')!
    expect((await post(worker, `/api/todos/${signTodo.id}/transfer`, { toUserId: 'h-lead' })).status).toBe(400)
  })

  it('采购到货与付款（R10）：按工单可见范围增查改、确认到货；模板下载 + 批量导入；只有财务能标记已付', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const fin = await login('h-fin')
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    const later = new Date(Date.now() + 8 * 3_600_000 + 30 * 86_400_000).toISOString().slice(0, 10)

    // 甲不能在别人的工单上登记；自己的可以
    expect((await send(pm, 'POST', '/api/purchases', { workOrderNumber: OTHER, materialName: 'x', quantity: 1, needDate: later })).status).toBe(403)
    const mine = await send(pm, 'POST', '/api/purchases', { workOrderNumber: MINE, materialName: '回转支承', quantity: 1, needDate: later })
    expect(mine.status).toBe(200)
    const mineId = ((await mine.json()) as { id: string }).id
    const otherRes = await send(lead, 'POST', '/api/purchases', { workOrderNumber: OTHER, materialName: '钢板', quantity: 2, needDate: later })
    const otherId = ((await otherRes.json()) as { id: string }).id
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
    expect((await upload(pm, new TextEncoder().encode('a,b,c'), 'p.csv')).status).toBe(400)

    // 付款申请：甲申请；甲不能标记已付，财务可以；甲看不到别人工单的付款申请
    expect((await send(pm, 'POST', '/api/payments', { purchaseLineIds: [otherId], amount: 1, requestDate: today, blocksDelivery: false })).status).toBe(403)
    const pay = await send(pm, 'POST', '/api/payments', { purchaseLineIds: [mineId], amount: 1200.5, requestDate: today, blocksDelivery: true })
    expect(pay.status).toBe(200)
    const payId = ((await pay.json()) as { id: string }).id
    const otherPay = await send(lead, 'POST', '/api/payments', { purchaseLineIds: [otherId], amount: 9, requestDate: today, blocksDelivery: false })
    const otherPayId = ((await otherPay.json()) as { id: string }).id
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
  it('出图任务（R11）：按工单可见范围增查改；只有设计负责人本人或管理员能标记出图；负责人本人不受工单范围限制；一键发放关联任务', async () => {
    const pm = await login('h-pm')
    const lead = await login('h-lead')
    const worker = await login('h-worker')
    const send = (sess: Record<string, string>, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, { method, headers: { cookie: cookieHeader(sess), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)

    // 项目经理甲不能在别人的工单上建；自己的工单可以（负责人是一线 h-worker）
    expect((await send(pm, 'POST', '/api/drawings', { workOrderNumber: OTHER, componentName: 'x', planDate: later })).status).toBe(403)
    expect((await send(pm, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: 'x', planDate: '2026/1/1' })).status).toBe(400)
    const mine = await send(pm, 'POST', '/api/drawings', { workOrderNumber: MINE, componentName: '主梁总图', ownerId: 'h-worker', planDate: later })
    expect(mine.status).toBe(200)
    const mineId = ((await mine.json()) as { id: string }).id
    // 领导在别人的工单上建一个，设计负责人是甲（甲看不到这个工单）
    const other = await send(lead, 'POST', '/api/drawings', { workOrderNumber: OTHER, componentName: '别人的图', ownerId: 'h-pm', planDate: later })
    const otherId = ((await other.json()) as { id: string }).id

    // 列表只含可见工单；"我的出图任务"含负责人是自己的（不受范围限制）
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

    // 标记出图：不是负责人 → 403；负责人本人 → 200；看不到工单的负责人也能标
    expect((await send(pm, 'POST', `/api/drawings/${mineId}/drawn`, {})).status).toBe(403)
    expect((await send(lead, 'POST', `/api/drawings/${mineId}/drawn`, {})).status).toBe(403)
    const drawn = await send(worker, 'POST', `/api/drawings/${mineId}/drawn`, {})
    expect(drawn.status).toBe(200)
    expect(await drawn.json()).toMatchObject({ status: 'DRAWN' })
    expect((await send(pm, 'POST', `/api/drawings/${otherId}/drawn`, {})).status).toBe(200)
    expect((await send(pm, 'PATCH', `/api/drawings/${mineId}`, { note: '能看到工单的人能改' })).status).toBe(200)

    // 一键发放：发放单记下 drawingTaskId，任务完成；别人工单的任务甲不能发
    const rel = await send(pm, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: '主梁总图发放', userIds: ['h-worker'], drawingTaskId: mineId })
    expect(rel.status).toBe(200)
    expect(await rel.json()).toMatchObject({ drawing: { status: 'DONE' } })
    expect((await send(pm, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: OTHER, description: 'x', userIds: ['h-worker'], drawingTaskId: otherId })).status).toBe(403)
    expect((await send(pm, 'POST', '/api/releases', { type: 'DRAWING', workOrderNumber: MINE, description: 'x', userIds: ['h-worker'], drawingTaskId: otherId })).status).toBe(400)
    const load = await get('/api/drawings/load', pm)
    expect(load.status).toBe(200)
  })
})
