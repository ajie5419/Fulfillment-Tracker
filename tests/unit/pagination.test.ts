import { describe, expect, it } from 'vitest'
import { listQuery, purchaseOptionsQuery } from '../../server/schemas/purchases'

describe('pagination query contract', () => {
  it('defaults to the first bounded page', () => {
    expect(listQuery.parse({})).toEqual({ page: 1, pageSize: 50 })
    expect(listQuery.parse({ page: '11', pageSize: '100', q: 'motor' })).toMatchObject({ page: 11, pageSize: 100, q: 'motor' })
  })
  it.each(['0', '-1', '1.5', 'abc', '', 'Infinity', ['1', '2'], Number.MAX_SAFE_INTEGER + 1])('rejects an invalid page: %j', (page) => {
    expect(listQuery.safeParse({ page }).success).toBe(false)
  })
  it.each(['0', '101', '1.5', ['20', '50']])('rejects an invalid page size: %j', (pageSize) => {
    expect(listQuery.safeParse({ pageSize }).success).toBe(false)
  })
  it('rejects unsafe offsets even when the page is a safe integer', () => {
    expect(listQuery.safeParse({ page: Number.MAX_SAFE_INTEGER, pageSize: 100 }).success).toBe(false)
  })
  it('bounds selected-ID hydration and requires a work order', () => {
    expect(purchaseOptionsQuery.safeParse({}).success).toBe(false)
    expect(purchaseOptionsQuery.parse({ workOrderNumber: 'WO', ids: 'chosen' }).ids).toEqual(['chosen'])
    expect(purchaseOptionsQuery.safeParse({ workOrderNumber: 'WO', ids: Array(51).fill('id') }).success).toBe(false)
    expect(purchaseOptionsQuery.safeParse({ workOrderNumber: 'WO', ids: [] }).success).toBe(false)
  })
})
