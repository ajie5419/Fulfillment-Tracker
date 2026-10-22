/** QMS 工单状态：已完工 / 已取消算"已关闭"，其他（含 QMS 以后新增的状态值）都算在做（zhao 10-22） */
import { describe, expect, it } from 'vitest'
import { isClosedWorkOrder, woStatusText } from '../../shared/status'

describe('isClosedWorkOrder', () => {
  it('已完工、已取消算已关闭，大小写不敏感', () => {
    expect(isClosedWorkOrder('COMPLETED')).toBe(true)
    expect(isClosedWorkOrder('CANCELLED')).toBe(true)
    expect(isClosedWorkOrder('completed')).toBe(true)
  })
  it('未开工、进行中、未知状态、空值都不算关闭（不会被误藏）', () => {
    for (const s of ['OPEN', 'IN_PROGRESS', 'PAUSED', '', null, undefined]) expect(isClosedWorkOrder(s)).toBe(false)
  })
  it('状态文字：认识的翻成中文，不认识的原样显示', () => {
    expect(woStatusText('COMPLETED')).toBe('已完工')
    expect(woStatusText('CANCELLED')).toBe('已取消')
    expect(woStatusText('PAUSED')).toBe('PAUSED')
    expect(woStatusText(null)).toBe('—')
  })
})
