import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/purchases/purchases', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/services/purchases/purchases')>(),
  createLine: vi.fn(),
}))

import { FlowError } from '../../server/services/flow/errors'
import { createLine } from '../../server/services/purchases/purchases'
import { convertPurchasePlan } from '../../server/services/purchases/plans'

const planId = 'plan-diagnostic'
const item = { id: 'item-failed', planId, partId: null, convertedLineId: null, needDate: new Date('2026-12-01'), quantity: 2, materialName: '电机', spec: 'X1', unit: '台', supplierName: '供应商', note: null }
beforeEach(() => {
  resetServiceDb()
  vi.mocked(createLine).mockReset()
  returns('purchasePlan.findUnique', { id: planId, status: 'ISSUED', workOrderNumber: 'WO', planNodeId: null })
  returns('purchasePlanItem.findMany', [{ id: item.id }, { id: 'item-ok' }])
  method('purchasePlanItem.findFirst').mockImplementation(async ({ where }) => ({ ...item, id: where.id }))
  method('purchasePlanItem.findFirstOrThrow').mockImplementation(async ({ where }) => ({ ...item, id: where.id }))
  returns('$queryRaw', [])
  returns('purchasePlanItem.update', {})
  returns('purchasePlanItem.count', 1)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('采购计划逐行转入诊断', () => {
  it('非业务异常记录计划、明细和原始错误，保持通用文案且继续后续行', async () => {
    const failure = new Error('database internal failure: purchase_line')
    vi.mocked(createLine).mockRejectedValueOnce(failure).mockResolvedValueOnce({ id: 'line-ok' } as Awaited<ReturnType<typeof createLine>>)

    const result = await convertPurchasePlan(planId, undefined, 'buyer')

    expect(result).toEqual({
      results: [{ itemId: item.id, error: '转入失败，请刷新后重试' }, { itemId: 'item-ok', lineId: 'line-ok' }],
      succeeded: 1,
      failed: 1,
    })
    expect(createLine).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[purchase-plans] 转入采购行失败', { planId, itemId: item.id }, failure)
    expect(serviceCalls.filter(call => String(call[0]).startsWith('transaction.')).map(call => call[0])).toEqual([
      'transaction.begin', 'transaction.rollback', 'transaction.begin', 'transaction.commit',
    ])
    expect(method('purchasePlanItem.update')).toHaveBeenCalledExactlyOnceWith({ where: { id: 'item-ok' }, data: { convertedLineId: 'line-ok' } })
  })

  it('业务异常仍返回原有文案，不记录非业务故障日志，后续行继续', async () => {
    vi.mocked(createLine).mockRejectedValueOnce(new FlowError('这一行已转采购行，不可重复转入')).mockResolvedValueOnce({ id: 'line-ok' } as Awaited<ReturnType<typeof createLine>>)
    await expect(convertPurchasePlan(planId, [item.id, 'item-ok'], 'buyer')).resolves.toEqual({
      results: [{ itemId: item.id, error: '这一行已转采购行，不可重复转入' }, { itemId: 'item-ok', lineId: 'line-ok' }],
      succeeded: 1,
      failed: 1,
    })
    expect(console.error).not.toHaveBeenCalled()
  })
})
