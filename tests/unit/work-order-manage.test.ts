/** 履约新建 / 修改 / 取消工单（写入 QMS 工单库）：服务层（假 QMS 客户端 + 假数据库）、QMS 写客户端、同步字段 */
import { describe, expect, it } from 'vitest'
import type { RoleContext } from '../../server/services/auth/permissions'
import { FlowError, FlowForbidden, FlowHttpError } from '../../server/services/flow/errors'
import { RESOURCES, type QmsWorkOrderRow, qmsWorkOrderSchema } from '../../server/services/sync/resources'
import { QMS_UNAVAILABLE_TEXT, type QmsWorkOrderApi, QmsRejected, QmsUnavailable, qmsWorkOrderClient } from '../../server/services/sync/write-client'
import { CONFLICT_TEXT, type ManageDb, NO_VERSION_TEXT, cancelWorkOrder, createWorkOrder, listCustomers, updateWorkOrder } from '../../server/services/workorder/manage'
import { createWorkOrderBody, updateWorkOrderBody } from '../../server/schemas/work-order'
import { defaultProjectManager, losesSightAfterCreate } from '../../shared/work-order-form'

const ctx = (over: Partial<RoleContext> = {}): RoleContext => ({ userId: 'u-me', isAdmin: false, roles: [], deptHeadOf: [], businessDept: 'PROJECT', pmOf: new Set(), ...over })
const project = ctx()
const tech = ctx({ businessDept: 'TECH' })

const T0 = new Date('2026-10-27T08:00:00.000Z')
const T1 = new Date('2026-10-27T09:00:00.123Z')

const qmsRow = (over: Partial<QmsWorkOrderRow> = {}): QmsWorkOrderRow => ({
  workOrderNumber: 'WO-1',
  customerName: '客户甲',
  customerNameId: 'c1',
  projectName: '项目',
  division: '一事业部',
  divisionId: 'd1',
  quantity: 2,
  deliveryDate: new Date('2026-12-31T00:00:00.000Z'),
  status: 'OPEN',
  version: 1,
  isDeleted: false,
  updatedAt: T1,
  ...over,
})

type Row = Record<string, unknown>
const defined = (o: Row) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** 内存假库：只实现服务层用到的方法；$transaction 里抛错时回滚（写入先记在副本里，成功才提交） */
function fakeDb(seed: { wos?: Row[]; users?: string[] } = {}) {
  const wos = new Map<string, Row>((seed.wos ?? []).map((w) => [w.workOrderNumber as string, w]))
  const exts = new Map<string, Row>()
  const users = new Set(seed.users ?? ['u-pm'])
  const saves = new Map<string, Row>()
  const workOrderLocalSave = {
    createMany: async ({ data }: { data: Row[] }) => {
      const row = data[0]!
      if (saves.has(String(row.operationId)) || [...saves.values()].some((r) => r.pendingWorkOrder === row.workOrderNumber)) return { count: 0 }
      saves.set(String(row.operationId), { ...row, attempts: 0, remoteResult: null, remoteError: null })
      return { count: 1 }
    },
    findUnique: async ({ where }: { where: Row }) => where.operationId ? saves.get(String(where.operationId)) ?? null : [...saves.values()].find((r) => r.pendingWorkOrder === where.pendingWorkOrder) ?? null,
    updateMany: async ({ where }: { where: Row }) => {
      const row = saves.get(String(where.operationId))
      if (!row || row.status !== 'PENDING') return { count: 0 }
      saves.set(String(where.operationId), { ...row, attempts: Number(row.attempts) + 1 })
      return { count: 1 }
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const old = saves.get(String(where.operationId))!
      const row = { ...old, ...data, ...(data.attempts ? { attempts: Number(old.attempts) + 1 } : {}) }
      saves.set(String(where.operationId), row)
      return row
    },
  }
  const tables = (w: Map<string, Row>, e: Map<string, Row>, dirty = () => {}) => ({
    workOrderLocalSave,
    $queryRaw: async () => [],
    qmsWorkOrder: {
      findUnique: async ({ where }: { where: { workOrderNumber: string } }) => w.get(where.workOrderNumber) ?? null,
      // 与 MySQL 语义一致：createMany skipDuplicates 主键已有就跳过；updateMany 只改满足条件的行
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        dirty()
        let count = 0
        for (const d of data) {
          const k = d.workOrderNumber as string
          if (w.has(k)) {
            if (!skipDuplicates) throw new Error('P2002')
            continue
          }
          w.set(k, defined(d))
          count++
        }
        return { count }
      },
      updateMany: async ({ where, data }: { where: { workOrderNumber: string; updatedAt: { lte: Date } }; data: Row }) => {
        dirty()
        const cur = w.get(where.workOrderNumber)
        if (!cur || (cur.updatedAt as Date) > where.updatedAt.lte) return { count: 0 }
        w.set(where.workOrderNumber, { ...cur, ...defined(data) })
        return { count: 1 }
      },
    },
    workOrderExt: {
      upsert: async ({ where, create, update }: { where: { workOrderNumber: string }; create: Row; update: Row }) => {
        dirty()
        const cur = e.get(where.workOrderNumber)
        e.set(where.workOrderNumber, cur ? { ...cur, ...defined(update) } : defined(create))
      },
    },
  })
  const db = {
    ...tables(wos, exts),
    qmsUser: { findFirst: async ({ where }: { where: { id: string } }) => (users.has(where.id) ? { id: where.id } : null) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const w2 = new Map(wos)
      const e2 = new Map(exts)
      let changed = false
      const r = await fn(tables(w2, e2, () => { changed = true }))
      if (!changed) return r
      wos.clear()
      w2.forEach((v, k) => wos.set(k, v))
      exts.clear()
      e2.forEach((v, k) => exts.set(k, v))
      return r
    },
  }
  return { db: db as unknown as ManageDb, wos, exts }
}

/** 假 QMS：记下调用，按给定的实现返回 */
function fakeQms(impl: Partial<QmsWorkOrderApi> = {}) {
  const calls: { op: string; args: unknown[] }[] = []
  const rec =
    <K extends keyof QmsWorkOrderApi>(op: K, fallback: QmsWorkOrderApi[K]) =>
    (...args: unknown[]) => {
      calls.push({ op, args })
      return ((impl[op] ?? fallback) as (...a: unknown[]) => unknown)(...args)
    }
  const api = {
    findWorkOrder: rec('findWorkOrder', async () => qmsRow()),
    createWorkOrder: rec('createWorkOrder', async (b) => qmsRow({ workOrderNumber: b.workOrderNumber, quantity: b.quantity, version: 0 })),
    updateWorkOrder: rec('updateWorkOrder', async (no, b) => qmsRow({ workOrderNumber: no, version: b.version + 1, ...(b.quantity ? { quantity: b.quantity } : {}) })),
    cancelWorkOrder: rec('cancelWorkOrder', async (no, b) => qmsRow({ workOrderNumber: no, status: 'CANCELLED', version: b.version + 1 })),
    listCustomers: rec('listCustomers', async () => [{ id: 'c1', name: '客户甲' }]),
  } as QmsWorkOrderApi
  return { api, calls }
}

const local = (over: Row = {}): Row => ({ ...qmsRow({ updatedAt: T0 }), syncedAt: T0, ...over })
const createInput = createWorkOrderBody.parse({ workOrderNumber: ' WO-NEW ', customerNameId: 'c1', projectName: '新项目', quantity: 3, deliveryDate: '2026-12-31', projectManagerId: 'u-pm', productLine: '专用车', isPilot: true })

describe('新建工单 createWorkOrder', () => {
  it('QMS 成功后写本地副本（用 QMS 返回的对象）和扩展信息；actorUserId 是当前用户', async () => {
    const { db, wos, exts } = fakeDb()
    const { api, calls } = fakeQms()
    const r = await createWorkOrder(project, createInput, api, db)
    expect(calls[0]!.args[0]).toEqual({ workOrderNumber: 'WO-NEW', customerNameId: 'c1', projectName: '新项目', divisionId: null, quantity: 3, deliveryDate: '2026-12-31', actorUserId: 'u-me' })
    expect(r).toEqual({ workOrderNumber: 'WO-NEW', status: 'OPEN', version: 0, updatedAt: T1 })
    expect(wos.get('WO-NEW')).toMatchObject({ customerName: '客户甲', customerNameId: 'c1', divisionId: 'd1', version: 0, updatedAt: T1, quantity: 3 })
    expect(exts.get('WO-NEW')).toEqual({ workOrderNumber: 'WO-NEW', projectManagerId: 'u-pm', productLine: '专用车', isPilot: true })
  })

  it('QMS 失败（连不上 / 工单号已存在）本地什么都不写，错误原样往上抛', async () => {
    for (const err of [new QmsUnavailable('ECONNREFUSED'), new QmsRejected('工单号已存在', 409, 'WORK_ORDER_EXISTS')]) {
      const { db, wos, exts } = fakeDb()
      const { api } = fakeQms({
        createWorkOrder: async () => {
          throw err
        },
      })
      await expect(createWorkOrder(project, createInput, api, db)).rejects.toBe(err)
      expect(wos.size).toBe(0)
      expect(exts.size).toBe(0)
    }
  })

  it('无权限：其他部门、项目经理被拒，不调 QMS', async () => {
    for (const c of [tech, ctx({ businessDept: null, pmOf: new Set(['WO-1']) })]) {
      const { db } = fakeDb()
      const { api, calls } = fakeQms()
      await expect(createWorkOrder(c, createInput, api, db)).rejects.toBeInstanceOf(FlowForbidden)
      expect(calls).toHaveLength(0)
    }
    // 管理员、项目部负责人可以
    for (const c of [ctx({ isAdmin: true, businessDept: null }), ctx({ businessDept: null, roles: ['PROJECT_DEPT_HEAD'] })]) {
      const { db } = fakeDb()
      await expect(createWorkOrder(c, createInput, fakeQms().api, db)).resolves.toMatchObject({ workOrderNumber: 'WO-NEW' })
    }
  })

  it('项目经理不存在：先拒，不调 QMS', async () => {
    const { db } = fakeDb({ users: [] })
    const { api, calls } = fakeQms()
    await expect(createWorkOrder(project, createInput, api, db)).rejects.toThrow('项目经理不存在')
    expect(calls).toHaveLength(0)
  })
})

describe('修改工单 updateWorkOrder', () => {
  it('带本地副本的 version 和改过的字段调 QMS，成功后写回新版本号和扩展信息', async () => {
    const { db, wos, exts } = fakeDb({ wos: [local({ version: 5 })] })
    const { api, calls } = fakeQms()
    const r = await updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ version: 5, quantity: 9, status: 'IN_PROGRESS', productLine: '环卫' }), api, db)
    expect(calls[0]).toEqual({ op: 'updateWorkOrder', args: ['WO-1', { version: 5, actorUserId: 'u-me', quantity: 9, status: 'IN_PROGRESS' }] })
    expect(r.version).toBe(6)
    expect(wos.get('WO-1')).toMatchObject({ version: 6, quantity: 9, updatedAt: T1 })
    expect(exts.get('WO-1')).toEqual({ workOrderNumber: 'WO-1', productLine: '环卫' })
  })

  it('QMS 409 → "工单已被别人修改，请刷新后再改"，本地不写', async () => {
    const { db, wos, exts } = fakeDb({ wos: [local({ version: 5 })] })
    const { api } = fakeQms({
      updateWorkOrder: async () => {
        throw new QmsRejected('数据已被修改', 409, 'OPTIMISTIC_LOCK_CONFLICT')
      },
    })
    const err = await updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ version: 5, quantity: 9, isPilot: true }), api, db).catch((e) => e)
    expect(err).toBeInstanceOf(FlowHttpError)
    expect(err.statusCode).toBe(409)
    expect(err.message).toBe(CONFLICT_TEXT)
    expect(wos.get('WO-1')).toMatchObject({ version: 5, quantity: 2 })
    expect(exts.size).toBe(0)
  })

  it('QMS 的 400 / 404 中文 message 和状态码透传', async () => {
    const { db } = fakeDb({ wos: [local()] })
    const { api } = fakeQms({
      updateWorkOrder: async () => {
        throw new QmsRejected('事业部无效', 400, null)
      },
    })
    await expect(updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ version: 1, divisionId: 'bad' }), api, db)).rejects.toMatchObject({ message: '事业部无效', statusCode: 400 })
  })

  it('改工单号被拒，不调 QMS；带同一个工单号可以', async () => {
    const { db } = fakeDb({ wos: [local()] })
    const { api, calls } = fakeQms()
    await expect(updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ workOrderNumber: 'WO-2', version: 1, quantity: 3 }), api, db)).rejects.toThrow('工单号不能修改')
    expect(calls).toHaveLength(0)
    await expect(updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ workOrderNumber: 'WO-1', version: 1, quantity: 3 }), api, db)).resolves.toMatchObject({ version: 2 })
  })

  it('用编辑者打开时看到的 version，不用保存时本地最新的：两人基于同一 version 先后提交，第二个得到 409 文案', async () => {
    const { db, wos } = fakeDb({ wos: [local({ version: 5 })] })
    // 有状态的假 QMS：version 不符就 409
    let qmsVersion = 5
    const { api, calls } = fakeQms({
      updateWorkOrder: async (no, b) => {
        if (b.version !== qmsVersion) throw new QmsRejected('数据已被他人修改', 409, 'OPTIMISTIC_LOCK_CONFLICT')
        qmsVersion++
        return qmsRow({ workOrderNumber: no, version: qmsVersion, quantity: b.quantity ?? 2, updatedAt: new Date(T1.getTime() + qmsVersion) })
      },
    })
    // 甲、乙都在 version 5 时打开；甲先保存
    await updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ version: 5, quantity: 7 }), api, db)
    expect(wos.get('WO-1')).toMatchObject({ version: 6, quantity: 7 })
    // 乙后保存：本地最新已是 6，但乙看到的是 5 → 409，不覆盖甲的修改
    await expect(updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ version: 5, quantity: 8 }), api, db)).rejects.toMatchObject({ statusCode: 409, message: CONFLICT_TEXT })
    expect((calls[1]!.args[1] as { version: number }).version).toBe(5)
    expect(wos.get('WO-1')).toMatchObject({ version: 6, quantity: 7 })
  })

  it('只改项目经理 / 产品线 / 是否试点：不调 QMS，只写扩展信息', async () => {
    const { db, exts } = fakeDb({ wos: [local()] })
    const { api, calls } = fakeQms()
    await updateWorkOrder(project, 'WO-1', updateWorkOrderBody.parse({ projectManagerId: 'u-pm', isPilot: false }), api, db)
    expect(calls).toHaveLength(0)
    expect(exts.get('WO-1')).toEqual({ workOrderNumber: 'WO-1', projectManagerId: 'u-pm', isPilot: false })
  })

  it('工单不存在 404、已取消的不能改、本地没有版本号不能改、无权限 403', async () => {
    const { db } = fakeDb({ wos: [local({ workOrderNumber: 'WO-C', status: 'CANCELLED' }), local({ workOrderNumber: 'WO-NV', version: null }), local({ workOrderNumber: 'WO-D', isDeleted: true })] })
    const { api, calls } = fakeQms()
    const body = updateWorkOrderBody.parse({ version: 1, quantity: 3 })
    await expect(updateWorkOrder(project, 'NOPE', body, api, db)).rejects.toMatchObject({ statusCode: 404, message: '工单不存在' })
    await expect(updateWorkOrder(project, 'WO-D', body, api, db)).rejects.toMatchObject({ statusCode: 404 })
    await expect(updateWorkOrder(project, 'WO-C', body, api, db)).rejects.toThrow('已取消的工单不能修改')
    await expect(updateWorkOrder(project, 'WO-NV', updateWorkOrderBody.parse({ version: null, quantity: 3 }), api, db)).rejects.toThrow(NO_VERSION_TEXT)
    await expect(updateWorkOrder(project, 'WO-NV', updateWorkOrderBody.parse({ quantity: 3 }), api, db)).rejects.toThrow(NO_VERSION_TEXT)
    await expect(updateWorkOrder(tech, 'WO-NV', body, api, db)).rejects.toBeInstanceOf(FlowForbidden)
    expect(calls).toHaveLength(0)
  })
})

describe('取消工单 cancelWorkOrder', () => {
  it('带 version 调 QMS 取消，本地副本改成已取消（不删除）', async () => {
    const { db, wos } = fakeDb({ wos: [local({ version: 3 })] })
    const { api, calls } = fakeQms()
    const r = await cancelWorkOrder(project, 'WO-1', { version: 3 }, api, db)
    expect(calls[0]).toEqual({ op: 'cancelWorkOrder', args: ['WO-1', { version: 3, actorUserId: 'u-me' }] })
    expect(r).toMatchObject({ status: 'CANCELLED', version: 4 })
    expect(wos.get('WO-1')).toMatchObject({ status: 'CANCELLED', isDeleted: false, version: 4 })
  })

  it('409 版本冲突文案；QMS 连不上本地不变；无权限拒绝', async () => {
    const { db, wos } = fakeDb({ wos: [local()] })
    const conflict = fakeQms({
      cancelWorkOrder: async () => {
        throw new QmsRejected('conflict', 409, null)
      },
    })
    await expect(cancelWorkOrder(project, 'WO-1', { version: 0 }, conflict.api, db)).rejects.toMatchObject({ message: CONFLICT_TEXT, statusCode: 409 })
    const down = fakeQms({
      cancelWorkOrder: async () => {
        throw new QmsUnavailable('timeout')
      },
    })
    await expect(cancelWorkOrder(project, 'WO-1', { version: 1 }, down.api, db)).rejects.toMatchObject({ message: QMS_UNAVAILABLE_TEXT, statusCode: 503 })
    expect(wos.get('WO-1')).toMatchObject({ status: 'OPEN', version: 1 })
    await expect(cancelWorkOrder(tech, 'WO-1', { version: 1 }, fakeQms().api, db)).rejects.toBeInstanceOf(FlowForbidden)
    // 页面上没有版本号：不调 QMS，提示等同步
    const none = fakeQms()
    await expect(cancelWorkOrder(project, 'WO-1', { version: null }, none.api, db)).rejects.toThrow(NO_VERSION_TEXT)
    expect(none.calls).toHaveLength(0)
  })
})

describe('客户列表 listCustomers', () => {
  it('有权限现取 QMS；无权限拒绝', async () => {
    await expect(listCustomers(project, fakeQms().api)).resolves.toEqual([{ id: 'c1', name: '客户甲' }])
    await expect(listCustomers(tech, fakeQms().api)).rejects.toBeInstanceOf(FlowForbidden)
  })
})

// ───────────── QMS 写客户端 ─────────────

const cfg = { apiBase: 'http://qms.test:3000', clientId: 'fulfillment', clientSecret: 'super-secret-value-super-secret-00' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const woJson = { workOrderNumber: 'WO-1', customerName: '客户甲', customerNameId: 7, projectName: null, division: null, divisionId: null, quantity: 1, deliveryDate: '2026-12-31T00:00:00.000Z', status: 'OPEN', version: 0, isDeleted: false, updatedAt: '2026-10-27T09:00:00.123Z' }

describe('QMS 写客户端 qmsWorkOrderClient', () => {
  it('路径、方法、凭据头、请求体；解析工单对象（数字 ID 转字符串）', async () => {
    const seen: { url: string; method?: string; headers: Record<string, string>; body?: string }[] = []
    const fake: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), method: init?.method, headers: init!.headers as Record<string, string>, body: init?.body as string | undefined })
      return json({ code: 0, data: woJson })
    }
    const c = qmsWorkOrderClient(cfg, fake)
    const row = await c.createWorkOrder({ workOrderNumber: 'WO-1', customerNameId: '7', quantity: 1, deliveryDate: '2026-12-31', actorUserId: 'u' })
    await c.updateWorkOrder('WO/1', { version: 0, actorUserId: 'u', quantity: 2 })
    await c.cancelWorkOrder('WO-1', { version: 1, actorUserId: 'u' })
    expect(row).toMatchObject({ customerNameId: '7', version: 0, updatedAt: new Date('2026-10-27T09:00:00.123Z') })
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /api/integration/fulfillment/work-orders',
      'PUT /api/integration/fulfillment/work-orders/WO%2F1',
      'POST /api/integration/fulfillment/work-orders/WO-1/cancel',
    ])
    expect(seen[0]!.headers).toMatchObject({ 'X-Identity-Client-Id': 'fulfillment', 'X-Identity-Client-Secret': cfg.clientSecret, 'Content-Type': 'application/json' })
    expect(JSON.parse(seen[1]!.body!)).toEqual({ version: 0, actorUserId: 'u', quantity: 2 })
  })

  it('客户列表', async () => {
    const c = qmsWorkOrderClient(cfg, async () => json({ code: 0, data: [{ id: 1, name: '甲' }, { id: 'b', name: '乙' }] }))
    expect(await c.listCustomers()).toEqual([{ id: '1', name: '甲' }, { id: 'b', name: '乙' }])
  })

  it('400 / 404 / 409：状态码、中文 message、错误码透传', async () => {
    for (const [status, body, code] of [
      [400, { message: '客户无效' }, null],
      [404, { message: '工单不存在或已删除' }, null],
      [409, { code: 'OPTIMISTIC_LOCK_CONFLICT', message: '数据已被他人修改' }, 'OPTIMISTIC_LOCK_CONFLICT'],
      [409, { errorCode: 'WORK_ORDER_EXISTS', message: '工单号已存在' }, 'WORK_ORDER_EXISTS'],
      // QMS 实际的失败格式：错误码在 error.code 里，外层 code 是 -1
      [409, { code: -1, data: null, error: { code: 'OPTIMISTIC_LOCK_CONFLICT' }, message: '数据已被他人修改' }, 'OPTIMISTIC_LOCK_CONFLICT'],
      [409, { code: -1, data: null, error: { code: 'WORK_ORDER_EXISTS' }, message: '工单号已存在' }, 'WORK_ORDER_EXISTS'],
      [400, { code: -1, data: null, error: { code: 'BAD_REQUEST' }, message: '客户不存在' }, 'BAD_REQUEST'],
      [404, { code: -1, data: null, error: { code: 'NOT_FOUND' }, message: '工单不存在或已删除' }, 'NOT_FOUND'],
    ] as const) {
      const err = await qmsWorkOrderClient(cfg, async () => json(body, status))
        .updateWorkOrder('WO-1', { version: 0, actorUserId: 'u' })
        .catch((e) => e)
      expect(err).toBeInstanceOf(QmsRejected)
      expect(err).toMatchObject({ statusCode: status, message: body.message, code })
    }
  })

  it('未配置、连不上、5xx、401、格式不符 → "QMS 暂时连不上"（503），原因进 detail 且不带密钥', async () => {
    const cases: [typeof cfg, typeof fetch][] = [
      [{ ...cfg, clientSecret: '' }, async () => json({ code: 0, data: woJson })],
      [{ ...cfg, apiBase: '' }, async () => json({ code: 0, data: woJson })],
      [
        cfg,
        async () => {
          throw new TypeError('fetch failed')
        },
      ],
      [cfg, async () => json({ message: 'boom' }, 500)],
      [cfg, async () => json({ message: 'bad client' }, 401)],
      [cfg, async () => json({ code: 0, data: { workOrderNumber: 'x' } })],
      [cfg, async () => new Response('<html>', { status: 200 })],
      // 404 + HTML（QMS 还没有这个接口）：不当成"工单不存在"
      [cfg, async () => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })],
      [cfg, async () => json({}, 404)],
    ]
    for (const [c, f] of cases) {
      let called = false
      const err = await qmsWorkOrderClient(c, async (...a) => {
        called = true
        return f(...a)
      })
        .createWorkOrder({ workOrderNumber: 'WO-1', customerNameId: '7', quantity: 1, deliveryDate: '2026-12-31', actorUserId: 'u' })
        .catch((e) => e)
      expect(err).toBeInstanceOf(QmsUnavailable)
      expect(err.statusCode).toBe(503)
      expect(err.message).toBe(QMS_UNAVAILABLE_TEXT)
      expect(err.detail).not.toContain(cfg.clientSecret)
      if (!c.clientSecret || !c.apiBase) expect(called).toBe(false)
    }
  })

  it('错误都是 FlowError 子类（接口层统一转换）', () => {
    expect(new QmsUnavailable('x')).toBeInstanceOf(FlowError)
    expect(new QmsRejected('x', 409, null)).toBeInstanceOf(FlowHttpError)
  })
})

describe('工单同步字段（契约新增，可选）', () => {
  const base = { workOrderNumber: 'WO-1', customerName: '甲', quantity: 1, deliveryDate: '2026-12-31T00:00:00Z', status: 'OPEN', isDeleted: false, updatedAt: '2026-10-27T00:00:00Z' }

  it('新版 QMS 输出 customerNameId、division、divisionId、version 时写上', () => {
    expect(RESOURCES['work-orders'].schema.parse({ ...base, customerNameId: 7, division: '一事业部', divisionId: 'd1', version: 3 })).toMatchObject({
      customerNameId: '7',
      division: '一事业部',
      divisionId: 'd1',
      version: 3,
    })
  })

  it('旧 QMS 不输出时为 undefined（写库时不动这几列），输出 null 时为 null', () => {
    const old = qmsWorkOrderSchema.parse(base)
    for (const k of ['customerNameId', 'division', 'divisionId', 'version'] as const) expect(old[k]).toBeUndefined()
    const nul = qmsWorkOrderSchema.parse({ ...base, customerNameId: null, division: null, divisionId: '', version: null })
    expect(nul).toMatchObject({ customerNameId: null, division: null, divisionId: null, version: null })
  })

  it('本地已有更新的副本时同步不覆盖（条件写，不先读）；没有就插入', async () => {
    const { db: empty, wos: w0 } = fakeDb()
    await empty.$transaction(async (tx) => RESOURCES['work-orders'].write(tx, [qmsWorkOrderSchema.parse({ ...base, version: 2 })]))
    expect(w0.get('WO-1')).toMatchObject({ version: 2, customerName: '甲' })
    const { db, wos } = fakeDb({ wos: [local({ updatedAt: T1, version: 9 })] })
    await db.$transaction(async (tx) => RESOURCES['work-orders'].write(tx, [qmsWorkOrderSchema.parse({ ...base, version: 8, updatedAt: T0.toISOString() })]))
    expect(wos.get('WO-1')).toMatchObject({ version: 9 })
    await db.$transaction(async (tx) => RESOURCES['work-orders'].write(tx, [qmsWorkOrderSchema.parse({ ...base, version: 10, updatedAt: '2026-10-28T00:00:00Z' })]))
    expect(wos.get('WO-1')).toMatchObject({ version: 10, customerNameId: 'c1' })
  })
})

describe('新建工单弹窗：项目经理默认值、看不到提示（shared/work-order-form）', () => {
  it('默认填当前登录用户；拿不到当前用户时不填', () => {
    expect(defaultProjectManager({ id: 'u-me' })).toBe('u-me')
    expect(defaultProjectManager(null)).toBeUndefined()
  })

  it('可见范围受限的人把项目经理改成别人或清空 → 要确认；自己当项目经理、范围不受限、拿不到当前用户 → 不提示', () => {
    const limited = { id: 'u-me', limited: true }
    expect(losesSightAfterCreate(limited, 'u-other')).toBe(true)
    expect(losesSightAfterCreate(limited, undefined)).toBe(true)
    expect(losesSightAfterCreate(limited, null)).toBe(true)
    expect(losesSightAfterCreate(limited, 'u-me')).toBe(false)
    expect(losesSightAfterCreate({ id: 'u-me', limited: false }, 'u-other')).toBe(false)
    expect(losesSightAfterCreate(undefined, 'u-other')).toBe(false)
  })
})
