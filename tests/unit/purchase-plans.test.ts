import { describe, expect, it } from 'vitest'
import { purchasePlanEditable, purchasePlanProgress, purchasePlanTransition } from '../../shared/purchase-plans'
import { canOperate, type RoleContext } from '../../server/services/auth/permissions'

describe('采购计划完成度', () => {
  it('空清单，分母为 0', () => { expect(purchasePlanProgress([])).toEqual({ total: 0, converted: 0, arrived: 0 }) })
  it('按明细计数，取消仍算已转入，只有到货算已到货', () => {
    expect(purchasePlanProgress([
      { convertedLineId: null },
      { convertedLineId: '1', convertedLine: { status: 'OPEN' } },
      { convertedLineId: '2', convertedLine: { status: 'ARRIVED' } },
      { convertedLineId: '3', convertedLine: { status: 'CANCELLED' } },
    ])).toEqual({ total: 4, converted: 3, arrived: 1 })
  })
  it('撤销到货后实时减少，输入不修改', () => {
    const items = [{ convertedLineId: '1', convertedLine: { status: 'ARRIVED' } }]
    expect(purchasePlanProgress(items).arrived).toBe(1)
    expect(items[0]!.convertedLine.status).toBe('ARRIVED')
    expect(purchasePlanProgress([{ ...items[0]!, convertedLine: { status: 'OPEN' } }]).arrived).toBe(0)
  })
})
describe('采购计划状态机', () => {
  it.each(['DRAFT', 'WITHDRAWN'] as const)('%s 可编辑、下发，不可撤回', status => {
    expect(purchasePlanEditable(status)).toBe(true)
    expect(purchasePlanTransition(status, 'issue')).toBe('ISSUED')
    expect(purchasePlanTransition(status, 'withdraw')).toBeNull()
  })
  it('已下发锁定，不能重复下发，可以撤回', () => {
    expect(purchasePlanEditable('ISSUED')).toBe(false)
    expect(purchasePlanTransition('ISSUED', 'issue')).toBeNull()
    expect(purchasePlanTransition('ISSUED', 'withdraw')).toBe('WITHDRAWN')
  })
})
describe('采购计划专用权限', () => {
  const ctx = (businessDept: RoleContext['businessDept'], isAdmin = false): RoleContext => ({ businessDept, isAdmin, userId: 'u', roles: [], deptHeadOf: [], pmOf: new Set(['WO']) })
  it('技术部可建/下发，不可转入', () => { expect(canOperate(ctx('TECH'), 'purchasePlan')).toBe(true); expect(canOperate(ctx('TECH'), 'purchasePlanConvert')).toBe(false) })
  it('采购部可转入，不可建/下发', () => { expect(canOperate(ctx('PURCHASE'), 'purchasePlan')).toBe(false); expect(canOperate(ctx('PURCHASE'), 'purchasePlanConvert')).toBe(true) })
  it('项目经理只读，管理员两项均可', () => {
    expect(canOperate(ctx('PROJECT'), 'purchasePlan')).toBe(false)
    expect(canOperate(ctx('PROJECT'), 'purchasePlanConvert')).toBe(false)
    expect(canOperate(ctx(null, true), 'purchasePlan')).toBe(true)
    expect(canOperate(ctx(null, true), 'purchasePlanConvert')).toBe(true)
  })
})
