import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceDb } from '../helpers/service-db'
import { callWorkOrderHandler, stubWorkOrderHandlerGlobals } from '../helpers/work-order-handler'
import type { RoleContext } from '../../server/services/auth/permissions'
import { createWorkOrderBody, updateWorkOrderBody } from '../../server/schemas/work-order'
import { QmsRejected, QmsUnavailable, type QmsWorkOrderApi } from '../../server/services/sync/write-client'
import { createWorkOrder, updateWorkOrder, type ManageDb } from '../../server/services/workorder/manage'
import { retryWorkOrderSave } from '../../server/services/workorder/recovery'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))

const ctx: RoleContext = { userId: 'actor', isAdmin: true, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set() }
const input = createWorkOrderBody.parse({ idempotencyKey: 'same-operation', workOrderNumber: 'WO', customerNameId: 'customer', projectName: '项目', quantity: 1, deliveryDate: '2026-12-01', projectManagerId: 'pm', productLine: '产品线', isPilot: true })
const row = { workOrderNumber: 'WO', customerName: '客户', customerNameId: 'customer', projectName: '项目', division: null, divisionId: null, quantity: 1, deliveryDate: new Date('2026-12-01'), status: 'OPEN', version: 1, isDeleted: false, updatedAt: new Date('2026-11-02') }
const db = serviceDb as ManageDb
let records: Map<string, Record<string, unknown>>
let qms: QmsWorkOrderApi
beforeEach(() => {
  resetServiceDb()
  records = new Map()
  method('workOrderLocalSave.createMany').mockImplementation(async ({ data }) => {
    const r = data[0]
    if (records.has(r.operationId) || [...records.values()].some((old) => old.pendingWorkOrder === r.workOrderNumber)) return { count: 0 }
    records.set(r.operationId, { ...r, attempts: 0, remoteResult: null, remoteError: null, lastError: null, createdAt: new Date(), updatedAt: new Date() })
    return { count: 1 }
  })
  method('workOrderLocalSave.findUnique').mockImplementation(async ({ where }) => where.operationId ? records.get(where.operationId) ?? null : [...records.values()].find((r) => r.pendingWorkOrder === where.pendingWorkOrder) ?? null)
  method('workOrderLocalSave.update').mockImplementation(async ({ where, data }) => {
    const r = records.get(where.operationId)!
    for (const [key, value] of Object.entries(data)) r[key] = key === 'attempts' ? Number(r.attempts) + 1 : value
    return r
  })
  method('workOrderLocalSave.updateMany').mockImplementation(async ({ where }) => {
    const r = records.get(where.operationId)
    if (!r || r.status !== 'PENDING') return { count: 0 }
    r.attempts = Number(r.attempts) + 1
    return { count: 1 }
  })
  returns('$queryRaw', [{ operationId: 'same-operation' }])
  returns('qmsUser.findFirst', { id: 'pm' })
  returns('qmsWorkOrder.findUnique', row)
  returns('qmsWorkOrder.createMany', { count: 1 })
  returns('qmsWorkOrder.updateMany', { count: 1 })
  returns('workOrderExt.upsert', {})
  qms = { createWorkOrder: vi.fn(async () => row), updateWorkOrder: vi.fn(async () => row), cancelWorkOrder: vi.fn(async () => row), listCustomers: vi.fn(async () => []), findWorkOrder: vi.fn(async () => row) }
  stubWorkOrderHandlerGlobals(ctx, qms)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('QMS 前持久化 PENDING 及扩展载荷；本地首次失败保留记录，重试核对远端后补完', async () => {
  qms.createWorkOrder = vi.fn(async () => {
    expect(records.get('same-operation')).toMatchObject({ status: 'PENDING', operation: 'create', workOrderNumber: 'WO', extPayload: { projectManagerId: 'pm', productLine: '产品线', isPilot: true } })
    return row
  })
  method('workOrderExt.upsert').mockRejectedValueOnce(new Error('local disk failed'))
  const result = await createWorkOrder(ctx, input, qms, db)
  expect(result).toMatchObject({ workOrderNumber: 'WO', recovery: { status: 'PENDING', operationId: 'same-operation' } })
  expect(records.get('same-operation')).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'local disk failed' })
  expect(await retryWorkOrderSave('same-operation', qms, db)).not.toHaveProperty('recovery')
  expect(qms.findWorkOrder).toHaveBeenCalledWith('WO')
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
  expect(records.get('same-operation')).toMatchObject({ status: 'DONE', pendingWorkOrder: null, attempts: 2, lastError: null })
  expect(method('workOrderExt.upsert')).toHaveBeenLastCalledWith({ where: { workOrderNumber: 'WO' }, create: { workOrderNumber: 'WO', projectManagerId: 'pm', productLine: '产品线', isPilot: true }, update: { projectManagerId: 'pm', productLine: '产品线', isPilot: true } })
})

it('重复提交同一幂等标识返回已有结果，不重复创建；不同载荷不能复用标识', async () => {
  await createWorkOrder(ctx, input, qms, db)
  await createWorkOrder(ctx, input, qms, db)
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
  expect(records.size).toBe(1)
  await expect(createWorkOrder(ctx, { ...input, productLine: '另一个输入' }, qms, db)).rejects.toThrow('幂等标识')
})

it('远端响应丢失也终止为 FAILED，同一 key 重放失败而不再次调用 QMS', async () => {
  qms.createWorkOrder = vi.fn().mockRejectedValueOnce(new Error('response lost'))
  await expect(createWorkOrder(ctx, input, qms, db)).rejects.toThrow('response lost')
  await expect(createWorkOrder(ctx, input, qms, db)).rejects.toMatchObject({ statusCode: 500, message: 'response lost' })
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
  expect(records.get('same-operation')).toMatchObject({ status: 'FAILED', pendingWorkOrder: null, attempts: 1, lastError: 'response lost', completedAt: expect.any(Date) })
})

it('FAILED 不能从管理员端点恢复，拒绝前不查询或写入远端及本地扩展', async () => {
  qms.createWorkOrder = vi.fn().mockRejectedValueOnce(new Error('response lost'))
  await expect(createWorkOrder(ctx, input, qms, db)).rejects.toThrow()
  await expect(retryWorkOrderSave('same-operation', qms, db)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', message: expect.stringContaining('已失败') })
  expect(records.get('same-operation')).toMatchObject({ status: 'FAILED', attempts: 1 })
  expect(qms.findWorkOrder).not.toHaveBeenCalled()
  expect(method('workOrderExt.upsert')).not.toHaveBeenCalled()
})

it('更新的本地失败可补完，重试不重复调用远端 update', async () => {
  const update = updateWorkOrderBody.parse({ idempotencyKey: 'same-operation', version: 1, quantity: 2, productLine: '更新产品线' })
  qms.updateWorkOrder = vi.fn(async () => ({ ...row, quantity: 2, version: 2 }))
  qms.findWorkOrder = vi.fn(async () => ({ ...row, quantity: 2, version: 2 }))
  method('workOrderExt.upsert').mockRejectedValueOnce(new Error('local failed'))
  expect(await updateWorkOrder(ctx, 'WO', update, qms, db)).toHaveProperty('recovery.status', 'PENDING')
  await retryWorkOrderSave('same-operation', qms, db)
  expect(qms.updateWorkOrder).toHaveBeenCalledOnce()
  expect(records.get('same-operation')).toMatchObject({ operation: 'update', status: 'DONE' })
})

it('同工单未恢复时阻止新操作覆盖输入，跨用户不能复用幂等标识', async () => {
  method('workOrderExt.upsert').mockRejectedValueOnce(new Error('local failed'))
  await createWorkOrder(ctx, input, qms, db)
  await expect(createWorkOrder(ctx, { ...input, idempotencyKey: 'new-key' }, qms, db)).rejects.toMatchObject({ statusCode: 409, data: { operationId: 'same-operation' } })
  await expect(createWorkOrder({ ...ctx, userId: 'another' }, input, qms, db)).rejects.toMatchObject({ message: expect.stringContaining('幂等标识'), data: { operationId: 'same-operation' } })
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
})

it('远端明确拒绝终止记录并重放同一拒绝，不把拒绝的操作留在恢复队列', async () => {
  qms.createWorkOrder = vi.fn().mockRejectedValue(new QmsRejected('客户无效', 400, 'BAD_REQUEST'))
  await expect(createWorkOrder(ctx, input, qms, db)).rejects.toThrow('客户无效')
  expect(records.get('same-operation')).toMatchObject({ status: 'FAILED', pendingWorkOrder: null, attempts: 1, remoteError: { message: '客户无效', statusCode: 400, code: 'BAD_REQUEST' } })
  await expect(createWorkOrder(ctx, input, qms, db)).rejects.toThrow('客户无效')
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
})

it('QMS 成功后记录更新也失败：先前 PENDING 和尝试标记仍在，重试必须核对远端', async () => {
  const update = method('workOrderLocalSave.update').getMockImplementation()!
  method('workOrderLocalSave.update').mockRejectedValue(new Error('database lost'))
  expect(await createWorkOrder(ctx, input, qms, db)).toHaveProperty('recovery.status', 'PENDING')
  expect(records.get('same-operation')).toMatchObject({ status: 'PENDING', attempts: 1, remoteResult: null })
  method('workOrderLocalSave.update').mockImplementation(update)
  await retryWorkOrderSave('same-operation', qms, db)
  expect(qms.findWorkOrder).toHaveBeenCalledWith('WO')
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
})

it('进程在持久化意图后中断、attempts 仍为 0：管理员重试也必须先核对 QMS', async () => {
  records.set('crashed', { operationId: 'crashed', operation: 'create', actorId: 'actor', workOrderNumber: 'WO', status: 'PENDING', pendingWorkOrder: 'WO', attempts: 0,
    extPayload: {}, requestPayload: { workOrderNumber: 'WO', customerNameId: 'customer', projectName: '项目', quantity: 1, deliveryDate: '2026-12-01', actorUserId: 'actor' }, remoteResult: null })
  await retryWorkOrderSave('crashed', qms, db)
  expect(qms.findWorkOrder).toHaveBeenCalledWith('WO')
  expect(qms.createWorkOrder).not.toHaveBeenCalled()
})

it.each([
  ['create', undefined], ['create', 'first-key'],
  ['update', undefined], ['update', 'first-key'],
] as const)('%s（key=%s）QMS 瞬时失败保留 FAILED 并释放槽，随后新保存成功', async (operation, idempotencyKey) => {
  const api = operation === 'create' ? qms.createWorkOrder : qms.updateWorkOrder
  vi.mocked(api).mockRejectedValueOnce(new QmsUnavailable('connection reset'))
  const save = (key?: string) => operation === 'create'
    ? createWorkOrder(ctx, { ...input, idempotencyKey: key }, qms, db)
    : updateWorkOrder(ctx, 'WO', updateWorkOrderBody.parse({ idempotencyKey: key, version: 1, quantity: 2, productLine: '更新产品线' }), qms, db)
  await expect(save(idempotencyKey)).rejects.toMatchObject({ statusCode: 503 })
  const failed = [...records.values()][0]!
  expect(failed).toMatchObject({ status: 'FAILED', pendingWorkOrder: null, lastError: 'QMS 暂时连不上，请稍后再试',
    completedAt: expect.any(Date), remoteError: { statusCode: 503, code: 'INTERNAL' } })
  await expect(save(idempotencyKey ? 'next-key' : undefined)).resolves.not.toHaveProperty('recovery')
  expect(records.size).toBe(2)
  expect(failed.status).toBe('FAILED')
  expect([...records.values()][1]).toMatchObject({ status: 'DONE', pendingWorkOrder: null })
  expect(api).toHaveBeenCalledTimes(2)
})

it.each([
  ['create', undefined], ['create', 'same-operation'],
  ['update', undefined], ['update', 'same-operation'],
  ['ext', undefined], ['ext', 'same-operation'],
] as const)('存在 PENDING 时 %s（key=%s）返回原 operationId，不能自动重试或覆盖输入', async (operation, idempotencyKey) => {
  method('workOrderExt.upsert').mockRejectedValueOnce(new Error('local failed'))
  await createWorkOrder(ctx, input, qms, db)
  const save = operation === 'create' ? createWorkOrder(ctx, { ...input, idempotencyKey }, qms, db)
    : updateWorkOrder(ctx, 'WO', updateWorkOrderBody.parse({ idempotencyKey, ...(operation === 'update' ? { version: 1, quantity: 2 } : {}), productLine: '不能覆盖' }), qms, db)
  await expect(save).rejects.toMatchObject({ statusCode: 409, data: { operationId: 'same-operation' } })
  expect(records.size).toBe(1)
  expect(records.get('same-operation')).toMatchObject({ status: 'PENDING', attempts: 1, pendingWorkOrder: 'WO', extPayload: { productLine: '产品线' } })
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
  expect(qms.updateWorkOrder).not.toHaveBeenCalled()
})

it('DONE 不能从管理员端点再次恢复，普通保存的成功幂等重放不变', async () => {
  const result = await createWorkOrder(ctx, input, qms, db)
  await expect(retryWorkOrderSave('same-operation', qms, db)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', message: expect.stringContaining('已完成') })
  await expect(createWorkOrder(ctx, input, qms, db)).resolves.toEqual(result)
  expect(qms.createWorkOrder).toHaveBeenCalledOnce()
  expect(qms.findWorkOrder).not.toHaveBeenCalled()
})

it.each(['create', 'update'] as const)('%s handler：无 key 的 QMS 瞬时失败返回 503，再次保存为 200', async (kind) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(kind === 'create' ? qms.createWorkOrder : qms.updateWorkOrder).mockRejectedValueOnce(new QmsUnavailable('connection reset'))
  const body = kind === 'create' ? { ...input, idempotencyKey: undefined } : { version: 1, quantity: 2, productLine: '更新产品线' }
  expect(await callWorkOrderHandler(kind, body)).toMatchObject({ statusCode: 503, body: { data: { code: 'INTERNAL' } } })
  const operationId = [...records.keys()][0]!
  expect(await callWorkOrderHandler('retry', undefined, operationId)).toMatchObject({ statusCode: 409, body: { message: expect.stringContaining('已失败'), data: { code: 'CONFLICT' } } })
  expect(await callWorkOrderHandler(kind, body)).toMatchObject({ statusCode: 200, body: { workOrderNumber: 'WO' } })
})

it.each(['create', 'update'] as const)('%s handler：无 key 的远端成功＋本地失败返回 202，管理员重试补完为 200', async (kind) => {
  method('workOrderExt.upsert').mockRejectedValueOnce(new Error('local failed'))
  const body = kind === 'create' ? { ...input, idempotencyKey: undefined } : { version: 1, quantity: 2, productLine: '更新产品线' }
  const response = await callWorkOrderHandler(kind, body)
  const operationId = [...records.keys()][0]!
  expect(response).toMatchObject({ statusCode: 202, body: { recovery: { status: 'PENDING', operationId } } })
  expect(await callWorkOrderHandler('retry', undefined, operationId)).toMatchObject({ statusCode: 200, body: { workOrderNumber: 'WO' } })
  expect(records.get(operationId)).toMatchObject({ status: 'DONE', pendingWorkOrder: null })
})

it.each([undefined, 'same-operation'])('create handler：已有 PENDING（key=%s）在 409 JSON 中披露可用的 operationId', async (idempotencyKey) => {
  method('workOrderExt.upsert').mockRejectedValueOnce(new Error('local failed'))
  const body = { ...input, idempotencyKey }
  expect(await callWorkOrderHandler('create', body)).toMatchObject({ statusCode: 202 })
  const operationId = [...records.keys()][0]!
  expect(await callWorkOrderHandler('create', body)).toMatchObject({ statusCode: 409, body: { data: { code: 'CONFLICT', operationId } } })
  expect(await callWorkOrderHandler('retry', undefined, operationId)).toMatchObject({ statusCode: 200 })
  expect(await callWorkOrderHandler('retry', undefined, operationId)).toMatchObject({ statusCode: 409, body: { message: expect.stringContaining('已完成'), data: { code: 'CONFLICT' } } })
})
