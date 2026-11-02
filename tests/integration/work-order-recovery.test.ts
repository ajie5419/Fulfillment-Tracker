/** 真实 MySQL：本地事务回滚与同幂等标识的并发串行；QMS 使用内存替身。 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'
import type { ManageDb } from '../../server/services/workorder/manage'
import type { QmsWorkOrderApi } from '../../server/services/sync/write-client'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const prefix = 'T-B6-RECOVERY-'
describe.skipIf(!DB)('工单本地保存恢复', () => {
  let db: PrismaClient
  let manage: typeof import('../../server/services/workorder/manage')
  let recovery: typeof import('../../server/services/workorder/recovery')
  const now = new Date('2040-05-15T04:00:00Z')
  const ctx = { userId: `${prefix}actor`, isAdmin: true, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set<string>() }
  const row = (no: string) => ({ workOrderNumber: no, customerName: '恢复测试', customerNameId: 'customer', projectName: null, division: null, divisionId: null, quantity: 1, deliveryDate: now, status: 'OPEN', version: 1, isDeleted: false, updatedAt: now })
  const api = (no: string): QmsWorkOrderApi => {
    let current: ReturnType<typeof row> | null = null
    return {
      createWorkOrder: vi.fn(async () => { current = row(no); return current }),
      findWorkOrder: vi.fn(async () => current), updateWorkOrder: vi.fn(async () => row(no)),
      cancelWorkOrder: vi.fn(async () => row(no)), listCustomers: vi.fn(async () => []),
    }
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
    recovery = await import('../../server/services/workorder/recovery')
    await clean()
  })
  afterAll(async () => { if (db) { await clean(); await db.$disconnect() } })

  it('QMS 成功但扩展字段首次提交失败：副本回滚、PENDING 保留，再次调用补完', async () => {
    const no = `${prefix}ROLLBACK`
    let fail = true
    const faultDb = db.$extends({ query: { workOrderExt: { async upsert({ args, query }) {
      if (fail) { fail = false; throw new Error('injected local failure') }
      return query(args)
    } } } }) as unknown as ManageDb
    const qms = api(no)
    const result = await manage.createWorkOrder(ctx, { idempotencyKey: no, workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15', productLine: '不能丢失的输入', isPilot: true }, qms, faultDb)
    expect(result.recovery).toMatchObject({ status: 'PENDING', operationId: no })
    expect(await db.qmsWorkOrder.findUnique({ where: { workOrderNumber: no } })).toBeNull()
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: no } })).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'injected local failure', extPayload: { productLine: '不能丢失的输入', isPilot: true } })
    await recovery.retryWorkOrderSave(no, qms, db)
    expect(await db.workOrderExt.findUnique({ where: { workOrderNumber: no } })).toMatchObject({ productLine: '不能丢失的输入', isPilot: true })
    expect(await db.workOrderLocalSave.findUnique({ where: { operationId: no } })).toMatchObject({ status: 'DONE', attempts: 2, pendingWorkOrder: null })
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
    expect(qms.findWorkOrder).toHaveBeenCalledWith(no)
  })

  it('并发提交同一幂等标识只创建一次 QMS 工单', async () => {
    const no = `${prefix}CONCURRENT`
    const qms = api(no)
    const input = { idempotencyKey: no, workOrderNumber: no, customerNameId: 'customer', quantity: 1, deliveryDate: '2040-05-15' }
    const results = await Promise.all([manage.createWorkOrder(ctx, input, qms, db), manage.createWorkOrder(ctx, input, qms, db)])
    expect(results.every((r) => !r.recovery)).toBe(true)
    expect(qms.createWorkOrder).toHaveBeenCalledOnce()
    expect(await db.workOrderLocalSave.count({ where: { operationId: no, status: 'DONE' } })).toBe(1)
  })
})
