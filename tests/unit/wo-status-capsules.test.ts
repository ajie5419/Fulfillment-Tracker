import { describe, expect, it } from 'vitest'
import { visibleWoStatusCapsules, woStatusCapsules, type WoStatusFields } from '../../shared/wo-status-capsules'

describe('工单状态胶囊字段映射', () => {
  it.each([
    ['shortage', '缺料 2', 'late'], ['purchasePending', '外购件未到 2', 'late'],
    ['drawingOverdue', '设计逾期 2', 'late'], ['overdueIssues', '超期异常 2', 'late'],
    ['overdueSteps', '外协未回 2', 'late'], ['incompleteNodes', '未齐套 2', 'risk'],
    ['unsignedReleases', '未签收 2', 'risk'], ['stagnationRedDays', '停滞 2 天', 'late'],
    ['stagnationYellowDays', '停滞关注 2 天', 'risk'],
  ])('%s → %s', (key, text, tone) => {
    expect(woStatusCapsules({ [key]: 2 })).toMatchObject([{ text, tone }])
  })
  it('缺失、零计数和负计数不造胶囊', () => {
    expect(woStatusCapsules({})).toEqual([])
    expect(woStatusCapsules({ shortage: 0, purchasePending: 0, drawingOverdue: -1, stagnationRedDays: null, stagnationYellowDays: null })).toEqual([])
  })
  it('缺料与全部未到货相等时仅保留缺料', () => {
    expect(woStatusCapsules({ shortage: 3, purchasePending: 3 }).map((c) => c.text)).toEqual(['缺料 3'])
  })
  it('未到货行含非缺料行时，排除缺料子集再显示，不重复表达同一行', () => {
    expect(woStatusCapsules({ shortage: 3, purchasePending: 8 })).toMatchObject([
      { text: '缺料 3', tone: 'late' }, { text: '外购件未到 5', hint: '未到货共 8 行，已排除缺料 3 行' },
    ])
  })
  it('只有 shortage 字段时不冒充采购未到货，也不产生负数胶囊', () => {
    expect(woStatusCapsules({ shortage: 3 }).map((c) => c.key)).toEqual(['shortage'])
    expect(woStatusCapsules({ shortage: 3, purchasePending: 1 }).map((c) => c.key)).toEqual(['shortage'])
  })
  const all: WoStatusFields = { shortage: 1, purchasePending: 3, drawingOverdue: 2, overdueIssues: 4, overdueSteps: 5, incompleteNodes: 6, stagnationRedDays: 17, stagnationYellowDays: 8, unsignedReleases: 7 }
  it('红先黄后，同色依词表序；红线存在时不再显示黄色停滞', () => {
    expect(woStatusCapsules(all).map((c) => [c.text, c.tone])).toEqual([
      ['缺料 1', 'late'], ['外购件未到 2', 'late'], ['设计逾期 2', 'late'], ['超期异常 4', 'late'],
      ['外协未回 5', 'late'], ['停滞 17 天', 'late'], ['未齐套 6', 'risk'], ['未签收 7', 'risk'],
    ])
  })
  it('最多四枚含 +N；折叠数准确且完整状态仍可用于悬停', () => {
    const result = visibleWoStatusCapsules(all)
    expect(result.visible.map((c) => c.text)).toEqual(['缺料 1', '外购件未到 2', '设计逾期 2'])
    expect(result.hidden).toHaveLength(5)
    expect([...result.visible, ...result.hidden]).toEqual(result.all)
  })
  it.each([0, 1, 4])('仅 %s 项时不出现 +N', (count) => {
    const result = visibleWoStatusCapsules(Object.fromEntries(Object.entries(all).slice(0, count)))
    expect(result.visible).toHaveLength(count)
    expect(result.hidden).toEqual([])
  })
})
