import { describe, expect, it } from 'vitest'
import { isPurchaseQuantity, MAX_PURCHASE_QUANTITY, MIN_PURCHASE_QUANTITY } from '../../shared/purchase-quantity'
import { newLineBody, patchLineBody } from '../../server/schemas/purchases'
import { parseQuantity, validateRows } from '../../server/services/purchases/import'

const line = { workOrderNumber: 'WO-1', materialName: '钢板', needDate: '2026-11-20' }
const context = { workOrders: new Set(['WO-1']), canSee: () => true, suppliers: [], users: [], parts: [], existing: [], today: '2026-11-10' }

describe('采购数量边界在新建、修改与 Excel 导入中一致', () => {
  it.each([
    [MIN_PURCHASE_QUANTITY, true],
    [1, true],
    [1.001, true],
    [1.234, true],
    [0.1 + 0.2, true],
    [1.1 + 2.2, true],
    [16777216.001, true],
    [536870912.001, true],
    [MAX_PURCHASE_QUANTITY - MIN_PURCHASE_QUANTITY, true],
    [MAX_PURCHASE_QUANTITY, true],
    [MAX_PURCHASE_QUANTITY + MIN_PURCHASE_QUANTITY, false],
    [0, false],
    [-1, false],
    [MIN_PURCHASE_QUANTITY / 10, false],
    [1e-12, false],
    [1.2345, false],
    [16777216.0011, false],
    [536870912.0001, false],
    [MAX_PURCHASE_QUANTITY - 0.0001, false],
    [MIN_PURCHASE_QUANTITY + 0.0001, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
  ])('数量 %s 的合法性为 %s', (quantity, valid) => {
    expect(isPurchaseQuantity(quantity)).toBe(valid)
    expect(newLineBody.safeParse({ ...line, quantity }).success).toBe(valid)
    expect(patchLineBody.safeParse({ quantity }).success).toBe(valid)
    expect(parseQuantity(quantity) !== undefined).toBe(valid)
    const imported = validateRows([{ row: 2, values: { ...line, quantity } }], context)
    expect(imported.errors.length === 0).toBe(valid)
    expect(imported.lines).toHaveLength(valid ? 1 : 0)
  })

  it('Excel 文本解析保留千位分隔符，解析后执行相同规则', () => {
    expect(parseQuantity('1,200.001')).toBe(1200.001)
    expect(parseQuantity('1,200.0001')).toBeUndefined()
    expect(parseQuantity('')).toBeUndefined()
    expect(parseQuantity('abc')).toBeUndefined()
  })
})
