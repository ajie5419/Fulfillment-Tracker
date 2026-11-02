/** 真实 MySQL：本地事务回滚与同幂等标识的并发串行；QMS 使用内存替身。 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'
import { callWorkOrderHandler, stubWorkOrderHandlerGlobals } from '../helpers/work-order-handler'
import type { ManageDb } from '../../server/services/workorder/manage'
import { QmsRejected, QmsUnavailable, type QmsWorkOrderApi } from '../../server/services/sync/write-client'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const prefix = 'T-B6-RECOVERY-'
describe.skipIf(!DB)('工单本地保存恢复', () => {
  let db: PrismaClient
  let manage: typeof import('../../server/services/workorder/manage')
  let realCreate: typeof manage.createWorkOrder
  let realUpdate: typeof manage.updateWorkOrder
  const now = new Date('2040-05-15T04:00:00Z')
  const ctx = { userId: `${prefix}actor`, isAdmin: true, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set<string>() }
  const row = (no: string) => ({ workOrderNumber: no, customerName: '恢复测试', customerNameId: 'customer', projectName: null, division: null, divisionId: null, quantity: 1, deliveryDate: now, status: 'OPEN', version: 1, isDeleted: false, updatedAt: now })
  const api = (no: string): QmsWorkOrderApi => {
    let current: ReturnType<typeof row> | null = null
    return {
      createWorkOrder: vi.fn(async () => { current = row(no); return current }),
      findWorkOrder: vi.fn(async () => current), updateWorkOrder: vi.fn(async (_no, body) => {
        current = { ...row(no), quantity: body.quantity ?? 1, version: body.version + 1 }
        return current
      }),
      cancelWorkOrder: vi.fn(async () => row(no)), listCustomers: vi.fn(async () => []),
    }
  }
  function useHandlers(qms: QmsWorkOrderApi, database: ManageDb = db) {
    stubWorkOrderHandlerGlobals(ctx, qms)
    // handler、服务和事务均用真实实现，仅注入可制造本地提交失败的数据库客户端。
    vi.spyOn(manage, 'createWorkOrder').mockImplementation((actor, input, remote) => realCreate(actor, input, remote, database))
    vi.spyOn(manage, 'updateWorkOrder').mockImplementation((actor, no, input, remote) => realUpdate(actor, no, input, remote, database))
  }
  async function clean() {
    await db.workOrderLocalSave.deleteMany({ where: { workOrderNumber: { startsWith: prefix } } })
    await db.workOrderExt.deleteMany({ where: { workOrderNumber: { startsWith: prefix } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { startsWith: prefix } } })
  }
  beforeAll(async () => {
    execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    manage = await import('../../server/services/workorder/manage')
    realCreate = manage.createWorkOrder
    realUpdate = manage.updateWorkOrder
    await clean()
  })
  afterAll(async () => { if (db) { await clean(); await db.$disconnect() } })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('QMS 成功但扩展字段首次提交失败：副本回滚、PENDING 保留，再次调用补完', async () => {
    const no = `${prefix}ROLLBACK`
    let fail = true
    const faultDb = db.$extends({ query: { workOrderExt: { async upsert({ args, query }) {
      if (fail) { fail = false; throw new Error('injected local failure') }
      return query(args)
    } } } }) as unknown as ManageDb
    const qms = api(no)
    useHandlers(qms, faultDb)
    const response = await callWorkOrderHandler('create', { idempotencyKey: no, workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15', productLine: '不能丢失的输入', isPilot: true })
    expect(response).toMatchObject({ statusCode: 202, body: { recovery: { status: 'PENDING', operationId: no } } })
    expect(await db.qmsWorkOrder.findUnique({ where: { workOrderNumber: no } })).toBeNull()
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: no } })).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'injected local failure', extPayload: { productLine: '不能丢失的输入', isPilot: true } })
    expect(await callWorkOrderHandler('retry', undefined, no)).toMatchObject({ statusCode: 200 })
    expect(await db.workOrderExt.findUnique({ where: { workOrderNumber: no } })).toMatchObject({ productLine: '不能丢失的输入', isPilot: true })
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: no } })).toMatchObject({ status: 'DONE', attempts: 2, pendingWorkOrder: null })
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
    expect(qms.findWorkOrder).toHaveBeenCalledWith(no)
  })

  it('并发提交同一幂等标识只创建一次 QMS 工单', async () => {
    const no = `${prefix}CONCURRENT`
    const qms = api(no)
    const input = { idempotencyKey: no, workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15' }
    const results = await Promise.allSettled([manage.createWorkOrder(ctx, input, qms, db), manage.createWorkOrder(ctx, input, qms, db)])
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
    for (const result of results) {
      if (result.status === 'fulfilled') expect(result.value).not.toHaveProperty('recovery')
      else expect(result.reason).toMatchObject({ statusCode: 409, data: { operationId: no } })
    }
    // 并发时若读到了尚未完成的意图，会披露 ID；完成后的同 key 重放仍返回原成功响应。
    expect(await manage.createWorkOrder(ctx, input, qms, db)).not.toHaveProperty('recovery')
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
    expect(await db.workOrderLocalSave.count({ where: { operationId: no, status: 'DONE' } })).toBe(1)
  })

  it.each([
    ['create', false], ['create', true], ['update', false], ['update', true],
  ] as const)('%s（带 key=%s）QMS 瞬时失败保留 FAILED 并释放唯一槽，下次保存返回 200', async (kind, keyed) => {
    const no = `${prefix}REMOTE-${kind}-${keyed ? 'KEY' : 'AUTO'}`
    if (kind === 'update') await db.qmsWorkOrder.create({ data: row(no) })
    const qms = api(no)
    vi.mocked(kind === 'create' ? qms.createWorkOrder : qms.updateWorkOrder).mockRejectedValueOnce(new QmsUnavailable('injected connection reset'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useHandlers(qms)
    const input = kind === 'create' ? { workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15', productLine: '保留输入' }
      : { version: 1, quantity: 2, productLine: '保留输入' }
    expect(await callWorkOrderHandler(kind, { ...input, idempotencyKey: keyed ? no : undefined }, no)).toMatchObject({ statusCode: 503 })
    const failed = await db.workOrderLocalSave.findFirstOrThrow({ where: { workOrderNumber: no } })
    expect(failed).toMatchObject({ status: 'FAILED', pendingWorkOrder: null, attempts: 1, lastError: 'QMS 暂时连不上，请稍后再试',
      completedAt: expect.any(Date), remoteError: { statusCode: 503, code: 'INTERNAL' }, extPayload: expect.objectContaining({ productLine: '保留输入' }) })
    expect(await callWorkOrderHandler(kind, { ...input, idempotencyKey: keyed ? `${no}-NEXT` : undefined }, no)).toMatchObject({ statusCode: 200 })
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: failed.operationId } })).toMatchObject({ status: 'FAILED', pendingWorkOrder: null })
    expect(await db.workOrderLocalSave.count({ where: { workOrderNumber: no } })).toBe(2)
    expect(await db.workOrderLocalSave.count({ where: { workOrderNumber: no, status: 'DONE', pendingWorkOrder: null } })).toBe(1)
    expect(kind === 'create' ? qms.createWorkOrder : qms.updateWorkOrder).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('已有 PENDING（带 key=%s）时 409 披露 operationId，调用重试端点补完', async (keyed) => {
    const no = `${prefix}PENDING-${keyed ? 'KEY' : 'AUTO'}`
    let fail = true
    const faultDb = db.$extends({ query: { workOrderExt: { async upsert({ args, query }) {
      if (fail) { fail = false; throw new Error('injected local failure') }
      return query(args)
    } } } }) as unknown as ManageDb
    const qms = api(no)
    useHandlers(qms, faultDb)
    const input = { idempotencyKey: keyed ? no : undefined, workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15', productLine: '待恢复输入' }
    expect(await callWorkOrderHandler('create', input)).toMatchObject({ statusCode: 202, body: { recovery: { status: 'PENDING', operationId: expect.any(String) } } })
    const pending = await db.workOrderLocalSave.findUniqueOrThrow({ where: { pendingWorkOrder: no } })
    expect(pending).toMatchObject({ status: 'PENDING', remoteResult: expect.objectContaining({ workOrderNumber: no }) })
    expect(await callWorkOrderHandler('create', input)).toMatchObject({ statusCode: 409, body: { data: { code: 'CONFLICT', operationId: pending.operationId } } })
    // 不同 key 的更新以及仅改扩展字段也必须披露同一个恢复 ID。
    await db.qmsWorkOrder.create({ data: row(no) })
    expect(await callWorkOrderHandler('update', { idempotencyKey: keyed ? `${no}-NEXT` : undefined, version: 1, quantity: 2 }, no)).toMatchObject({ statusCode: 409, body: { data: { operationId: pending.operationId } } })
    expect(await callWorkOrderHandler('update', { productLine: '不能覆盖' }, no)).toMatchObject({ statusCode: 409, body: { data: { operationId: pending.operationId } } })
    expect(await callWorkOrderHandler('retry', undefined, pending.operationId)).toMatchObject({ statusCode: 200 })
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: pending.operationId } })).toMatchObject({ status: 'DONE', pendingWorkOrder: null })
    expect(await db.workOrderExt.findUnique({ where: { workOrderNumber: no } })).toMatchObject({ productLine: '待恢复输入' })
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
    expect(qms.updateWorkOrder).not.toHaveBeenCalled()
  })

  it('管理员重试 FAILED 返回明确的 409，FAILED 审计行及失败输入保留', async () => {
    const no = `${prefix}FAILED-RETRY`
    const qms = api(no)
    vi.mocked(qms.createWorkOrder).mockRejectedValueOnce(new QmsRejected('客户无效', 400, 'BAD_REQUEST'))
    useHandlers(qms)
    expect(await callWorkOrderHandler('create', { workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15' })).toMatchObject({ statusCode: 400 })
    const failed = await db.workOrderLocalSave.findFirstOrThrow({ where: { workOrderNumber: no } })
    expect(await callWorkOrderHandler('retry', undefined, failed.operationId)).toMatchObject({ statusCode: 409, body: { message: expect.stringContaining('已失败'), data: { code: 'CONFLICT' } } })
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: failed.operationId } })).toEqual(failed)
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
    expect(qms.findWorkOrder).not.toHaveBeenCalled()
  })

  it('管理员重试 DONE 返回明确的 409，普通保存仍能幂等重放成功结果', async () => {
    const no = `${prefix}DONE-RETRY`
    const qms = api(no)
    useHandlers(qms)
    const input = { idempotencyKey: no, workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15' }
    const response = await callWorkOrderHandler('create', input)
    expect(response.statusCode).toBe(200)
    expect(await callWorkOrderHandler('retry', undefined, no)).toMatchObject({ statusCode: 409, body: { message: expect.stringContaining('已完成'), data: { code: 'CONFLICT' } } })
    expect(await callWorkOrderHandler('create', input)).toEqual(response)
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
  })
})
