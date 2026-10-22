/** 前端改版第二轮（手机端）的纯函数：工厂时区取日期、待办按截止日分组、主操作按钮、色调 */
import { describe, expect, it } from 'vitest'
import { kitTone, shortageReasonTags } from '../../shared/mobile-kitting'
import { addDays, dueGroup, dueStats, factoryDay, groupByDue, todoDueDay, todoPrimaryLabel, toneOfVant, weekEndDay } from '../../shared/mobile-todo'

describe('factoryDay / addDays / weekEndDay', () => {
  it('按 Asia/Shanghai 取日期，不看运行环境时区', () => {
    expect(factoryDay('2026-10-19T16:30:00.000Z')).toBe('2026-10-20') // 上海已是次日 00:30
    expect(factoryDay('2026-10-19T15:59:59.000Z')).toBe('2026-10-19')
    expect(factoryDay('2026-10-19T00:00:00.000Z')).toBe('2026-10-19') // 日期字段存当天 UTC 零点
    expect(factoryDay('2026-10-19')).toBe('2026-10-19')
  })
  it('跨月跨年加天数', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('本周到周日为止（周一为第一天）', () => {
    expect(weekEndDay('2026-10-19')).toBe('2026-10-25') // 周一
    expect(weekEndDay('2026-10-24')).toBe('2026-10-25') // 周六
    expect(weekEndDay('2026-10-25')).toBe('2026-10-25') // 周日
  })
})

describe('dueGroup / groupByDue / dueStats', () => {
  const today = '2026-10-22' // 周四
  it('已过期 / 今天 / 本周 / 以后 / 未定', () => {
    expect(dueGroup('2026-10-21', today)).toBe('OVERDUE')
    expect(dueGroup('2026-10-22', today)).toBe('TODAY')
    expect(dueGroup('2026-10-23', today)).toBe('WEEK')
    expect(dueGroup('2026-10-25', today)).toBe('WEEK')
    expect(dueGroup('2026-10-26', today)).toBe('LATER')
    expect(dueGroup(null, today)).toBe('NONE')
  })
  it('只返回有内容的组，组按固定顺序、组内按日期', () => {
    const items = [{ d: '2026-11-01' }, { d: null }, { d: '2026-10-20' }, { d: '2026-10-01' }, { d: '2026-10-22' }]
    const g = groupByDue(items, (t) => t.d, today)
    expect(g.map((x) => x.group)).toEqual(['OVERDUE', 'TODAY', 'LATER', 'NONE'])
    expect(g[0]!.items.map((t) => t.d)).toEqual(['2026-10-01', '2026-10-20'])
    expect(dueStats(items, (t) => t.d, today)).toEqual({ total: 5, overdue: 2, dueToday: 1 })
  })
})

describe('todoDueDay / todoPrimaryLabel', () => {
  it('总计划节点用计划日期，其余用 dueAt', () => {
    expect(todoDueDay({ dueAt: '2026-10-19T17:00:00Z', plan: { planDate: '2026-11-02' } })).toBe('2026-11-02')
    // 服务端给了 dueDay（含 null）时以服务端为准，与电脑端工作台同口径
    expect(todoDueDay({ dueDay: '2026-10-25', plan: { planDate: '2026-11-02' } })).toBe('2026-10-25')
    expect(todoDueDay({ dueDay: null, dueAt: '2026-10-19T17:00:00Z' })).toBe(null)
    expect(todoDueDay({ dueAt: '2026-10-19T17:00:00Z', plan: null })).toBe('2026-10-20')
    expect(todoDueDay({ dueAt: null })).toBeNull()
  })
  it('主操作与 open() 分支一致', () => {
    expect(todoPrimaryLabel({ action: 'CONFIRM_PLAN_NODE', plan: {} })).toBeNull()
    // 完成部门任务（部门计划二次分解）：手机上直接点完成
    expect(todoPrimaryLabel({ action: 'DO_PLAN_TASK', planTask: {} })).toBe('完成')
    expect(todoPrimaryLabel({ action: 'SIGN_RELEASE', release: {} })).toBe('去签收')
    expect(todoPrimaryLabel({ action: 'CONFIRM_CHANGE', release: {} })).toBe('去确认')
    expect(todoPrimaryLabel({ action: 'ARRANGE_SEND', step: { status: 'PENDING', mode: 'EXTERNAL_OUTSOURCE' } })).toBe('登记发出')
    expect(todoPrimaryLabel({ action: 'READY_TO_START', step: { status: 'PENDING', mode: 'EXTERNAL_OUTSOURCE' } })).toBe('登记发出')
    expect(todoPrimaryLabel({ action: 'READY_TO_START', step: { status: 'PENDING', mode: 'SELF' } })).toBe('开工')
    expect(todoPrimaryLabel({ action: 'READY_TO_START', step: { status: 'DONE', mode: 'SELF' } })).toBeNull()
    expect(todoPrimaryLabel({ action: 'ARRANGE_START', step: { status: 'PENDING', mode: 'SELF' } })).toBe('开工')
    expect(todoPrimaryLabel({ action: 'X', step: null })).toBeNull()
  })
  it('Vant 标签类型对应色调', () => {
    expect(['danger', 'warning', 'success', 'primary', 'default', undefined].map(toneOfVant)).toEqual(['late', 'risk', 'done', 'primary', 'none', 'none'])
  })
})

describe('齐套节点色调 / 缺件原因标签', () => {
  it('预警优先，其次是否齐套，清单空为灰', () => {
    expect(kitTone({ percent: null, incomplete: false, alertLevel: null })).toBe('none')
    expect(kitTone({ percent: 40, incomplete: true, alertLevel: 'RED' })).toBe('late')
    expect(kitTone({ percent: 40, incomplete: true, alertLevel: 'YELLOW' })).toBe('risk')
    expect(kitTone({ percent: 40, incomplete: true, alertLevel: null })).toBe('primary')
    expect(kitTone({ percent: 100, incomplete: false, alertLevel: null })).toBe('done')
  })
  it('同一原因合并计数，逾期 / 异常标红', () => {
    const tags = shortageReasonTags([
      { kind: 'part', reason: '等图纸', reasonCode: 'DRAWING', stage: null },
      { kind: 'purchase', reason: '未到货', reasonCode: 'NOT_ARRIVED', stage: '缺料', overdue: true },
      { kind: 'part', reason: '等图纸', reasonCode: 'DRAWING', stage: '下料' },
      { kind: 'part', reason: '有异常', reasonCode: 'BLOCKED', stage: '焊接' },
    ])
    expect(tags).toEqual([
      { text: '等图纸', count: 2, type: 'warning' },
      { text: '缺料', count: 1, type: 'danger' },
      { text: '有异常', count: 1, type: 'danger' },
    ])
  })
})

describe('手机端与电脑端工作台分组同一口径（功能重复梳理第三批）', () => {
  it('任意截止日：手机端 dueGroup 与电脑端 workBucket 结果一致', async () => {
    const { workBucket } = await import('../../shared/workbench')
    for (const today of ['2026-10-19', '2026-10-22', '2026-10-25']) {
      for (let i = -3; i <= 12; i++) {
        const due = addDays(today, i)
        const b = workBucket({ dueDay: due, kind: 'todo' }, today)
        expect(dueGroup(due, today)).toBe(b === 'NO_DUE' ? 'NONE' : b)
      }
      expect(dueGroup(null, today)).toBe('NONE')
    }
  })
})
