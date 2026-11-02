import { expect, it, vi } from 'vitest'
import { qmsWorkOrderClient } from '../../server/services/sync/write-client'

const cfg = { apiBase: 'http://qms.test', clientId: 'test', clientSecret: 'test' }
const row = (workOrderNumber: string) => ({ workOrderNumber, customerName: '客户', quantity: 1, deliveryDate: '2026-12-01T00:00:00Z', status: 'OPEN', isDeleted: false, updatedAt: '2026-11-02T00:00:00Z', version: 1 })
const page = (items: unknown[], nextCursor: unknown = null) => new Response(JSON.stringify({ code: 0, data: { items, nextCursor } }))

it('恢复查询沿已有同步契约翻页按工单号查找，使用相同身份凭据，保留软删除现状', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(page([row('OTHER')], { since: '2026-11-02T00:00:00Z', afterId: 'OTHER' }))
    .mockResolvedValueOnce(page([{ ...row('WO'), isDeleted: true }]))
  const found = await qmsWorkOrderClient(cfg, fetcher).findWorkOrder('WO')
  expect(found).toMatchObject({ workOrderNumber: 'WO', isDeleted: true })
  expect(fetcher).toHaveBeenCalledTimes(2)
  const url = new URL(String(fetcher.mock.calls[1]![0]))
  expect(url.pathname).toBe('/api/integration/fulfillment/work-orders')
  expect(url.searchParams.get('afterId')).toBe('OTHER')
  expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ 'X-Identity-Client-Id': 'test', 'X-Identity-Client-Secret': 'test' })
})

it('远端不存在返回 null；查询失败必须抛错，不能误判不存在而重新创建', async () => {
  expect(await qmsWorkOrderClient(cfg, vi.fn<typeof fetch>().mockResolvedValue(page([]))).findWorkOrder('WO')).toBeNull()
  await expect(qmsWorkOrderClient(cfg, vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))).findWorkOrder('WO')).rejects.toMatchObject({ statusCode: 503, detail: expect.stringContaining('offline') })
})
