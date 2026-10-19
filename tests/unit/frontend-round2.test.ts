/** 前端改版第二轮的纯函数：工作台按截止日分组、部门工作台按工单分组和完成度、齐套率平均与缺件原因计数、风险页汇总、工厂时区时间 */
import { describe, expect, it } from 'vitest'
import {
  NO_DEPT,
  averagePercent,
  distinctPlanNodes,
  factoryDateTimeText,
  factoryTimeText,
  groupByBucket,
  groupByWorkOrder,
  groupProgress,
  riskTallies,
  shortageReasonCounts,
  weekEndDay,
  workBucket,
} from '../../shared/workbench'

describe('weekEndDay', () => {
  it('周一到周日算一周，返回本周日；周日当天就是自己', () => {
    expect(weekEndDay('2026-10-19')).toBe('2026-10-25') // 周一
    expect(weekEndDay('2026-10-22')).toBe('2026-10-25') // 周四
    expect(weekEndDay('2026-10-25')).toBe('2026-10-25') // 周日
    expect(weekEndDay('2026-12-30')).toBe('2027-01-03') // 跨年
  })
})

describe('workBucket：按截止日分组', () => {
  const today = '2026-10-21' // 周三
  it('有截止日：过去 → 已过期；今天 → 今天；本周日前 → 本周；更晚 → 以后', () => {
    expect(workBucket({ kind: 'todo', dueDay: '2026-10-20' }, today)).toBe('OVERDUE')
    expect(workBucket({ kind: 'todo', dueDay: '2026-10-21' }, today)).toBe('TODAY')
    expect(workBucket({ kind: 'reminder', level: 'REMIND', dueDay: '2026-10-25' }, today)).toBe('WEEK')
    expect(workBucket({ kind: 'reminder', level: 'RED', dueDay: '2026-10-26' }, today)).toBe('LATER')
  })
  it('没有截止日：不管级别，一律归"未定截止日"', () => {
    expect(workBucket({ kind: 'reminder', level: 'RED', dueDay: null }, today)).toBe('NO_DUE')
    expect(workBucket({ kind: 'reminder', level: 'YELLOW', dueDay: null }, today)).toBe('NO_DUE')
    expect(workBucket({ kind: 'todo', dueDay: null }, today)).toBe('NO_DUE')
  })
  it('已消除的预警不再有截止日：归"未定截止日"', () => {
    expect(workBucket({ kind: 'reminder', level: 'RED', cleared: true, dueDay: '2026-10-01' }, today)).toBe('NO_DUE')
  })
  it('分组按 已过期 → 今天 → 本周 → 以后 排，空组去掉，组内保持原顺序', () => {
    const items = [
      { id: 'a', bucket: 'LATER' as const },
      { id: 'n', bucket: 'NO_DUE' as const },
      { id: 'b', bucket: 'OVERDUE' as const },
      { id: 'c', bucket: 'LATER' as const },
    ]
    expect(groupByBucket(items).map((g) => [g.bucket, g.items.map((i) => i.id)])).toEqual([
      ['OVERDUE', ['b']],
      ['LATER', ['a', 'c']],
      ['NO_DUE', ['n']],
    ])
  })
})

describe('部门工作台：按工单分组', () => {
  it('组的顺序按工单第一次出现的位置，组内保持原顺序', () => {
    const rows = [
      { id: 1, workOrderNumber: 'B' },
      { id: 2, workOrderNumber: 'A' },
      { id: 3, workOrderNumber: 'B' },
    ]
    expect(groupByWorkOrder(rows)).toEqual([
      { workOrderNumber: 'B', rows: [rows[0], rows[2]] },
      { workOrderNumber: 'A', rows: [rows[1]] },
    ])
  })
  it('本组完成度：不计入的（已取消）先排除', () => {
    const rows = [{ s: 'ARRIVED' }, { s: 'OPEN' }, { s: 'CANCELLED' }]
    expect(groupProgress(rows, (r) => r.s === 'ARRIVED', (r) => r.s !== 'CANCELLED')).toEqual({ done: 1, total: 2 })
    expect(groupProgress(rows, (r) => r.s === 'ARRIVED')).toEqual({ done: 1, total: 3 })
  })
  it('组里挂的总计划节点去重、按序号', () => {
    const n1 = { id: 'n1', seq: 2, name: '采购' }
    const n2 = { id: 'n2', seq: 1, name: '设计' }
    expect(distinctPlanNodes([{ planNode: n1 }, { planNode: null }, { planNode: n2 }, { planNode: n1 }])).toEqual([n2, n1])
  })
})

describe('齐套', () => {
  it('平均齐套率不算清单为空的节点，四舍五入；都为空时 null', () => {
    expect(averagePercent([{ percent: 50 }, { percent: null }, { percent: 75 }])).toBe(63)
    expect(averagePercent([{ percent: null }])).toBeNull()
  })
  it('缺件按原因计数，多的在前', () => {
    const s = [
      { reason: '物料未到', reasonCode: 'NOT_ARRIVED' },
      { reason: '加工中', reasonCode: 'IN_PROGRESS' },
      { reason: '物料未到', reasonCode: 'NOT_ARRIVED' },
    ]
    expect(shortageReasonCounts(s)).toEqual([
      { code: 'NOT_ARRIVED', reason: '物料未到', count: 2 },
      { code: 'IN_PROGRESS', reason: '加工中', count: 1 },
    ])
  })
})

describe('风险汇总', () => {
  it('预警只算活动中的红、黄（已转异常、提醒不算）；异常只算未关闭的，分超期 / 未超期；按部门计数，多部门各算一次', () => {
    const alerts = [
      { level: 'RED' as const, status: 'ACTIVE', deptNames: ['甲'] },
      { level: 'YELLOW' as const, status: 'ACTIVE', deptNames: ['甲', '乙'] },
      { level: 'RED' as const, status: 'CONVERTED', deptNames: ['甲'] },
      { level: 'REMIND' as const, status: 'ACTIVE', deptNames: ['乙'] },
      { level: 'YELLOW' as const, status: 'ACTIVE', deptNames: [] },
    ]
    const issues = [
      { status: 'OPEN', overdue: true, deptGroup: '乙' },
      { status: 'ACCEPTED', overdue: false, deptGroup: null },
      { status: 'CLOSED', overdue: false, deptGroup: '甲' },
    ]
    const t = riskTallies(alerts, issues)
    expect(t.bySeverity).toEqual({ RED: 1, YELLOW: 2, ISSUE_OVERDUE: 1, ISSUE_OPEN: 1 })
    expect(t.total).toBe(5)
    expect(t.byDept).toEqual([
      { name: '乙', count: 2 },
      { name: NO_DEPT, count: 2 },
      { name: '甲', count: 2 },
    ].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)))
  })
})

describe('factoryTimeText', () => {
  it('按工厂时区（UTC+8）显示，不受运行环境时区影响', () => {
    expect(factoryTimeText('2026-10-19T16:30:00Z')).toBe('10-20 00:30')
    expect(factoryTimeText(null)).toBe('')
  })
})

describe('factoryDateTimeText', () => {
  it('年月日 + 时分，按工厂时区', () => {
    expect(factoryDateTimeText('2026-12-31T16:05:00Z')).toBe('2027-01-01 00:05')
    expect(factoryDateTimeText(undefined)).toBe('')
  })
})
