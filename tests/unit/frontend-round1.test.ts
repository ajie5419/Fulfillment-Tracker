/** 前端改版第一轮的纯函数：状态归类、当前卡点、谁在拖、圆点省略、总览分组、要处理的事排序、甘特刻度 / 位置、交期对比条、工单详情的小规则 */
import { describe, expect, it } from 'vitest'
import { BOARD_COLOR, STATUS_COLOR, boardGroup, compactIndexes, lagByDept, nodeState, shortName, sortActions, stuckNode } from '../../shared/status'
import { dayNum, deliveryBar, ganttRange, monthTicks, nodeBars, numDay, pct } from '../../shared/gantt'
import { paymentText, pickMainAssembly, reasonCounts, taskListLink, taskState } from '../../server/services/workorder/rules'

describe('状态色口径', () => {
  it('看板红黄绿用同一套状态色', () => {
    expect(BOARD_COLOR).toEqual({ RED: STATUS_COLOR.late, YELLOW: STATUS_COLOR.risk, GREEN: STATUS_COLOR.done })
    expect(STATUS_COLOR).toMatchObject({ done: '#10B981', risk: '#F59E0B', upstream: '#F97316', late: '#E11D48', none: '#94A3B8', onTrack: '#2563EB' })
  })
})

describe('nodeState / stuckNode / lagByDept', () => {
  it('完成优先，其次源头，再受上游影响，否则按计划', () => {
    expect(nodeState({ done: true, source: false, upstream: true })).toBe('DONE')
    expect(nodeState({ done: false, source: true, upstream: true })).toBe('SOURCE')
    expect(nodeState({ done: false, source: false, upstream: true })).toBe('UPSTREAM')
    expect(nodeState({ done: false, source: false, upstream: false })).toBe('ON_TRACK')
  })
  it('当前卡点 = 序号最小的源头延误节点；没有为 null', () => {
    const nodes = [
      { id: 'c', seq: 3, state: 'SOURCE' as const },
      { id: 'a', seq: 1, state: 'DONE' as const },
      { id: 'b', seq: 2, state: 'SOURCE' as const },
    ]
    expect(stuckNode(nodes)?.id).toBe('b')
    expect(stuckNode([{ id: 'x', seq: 1, state: 'UPSTREAM' as const }])).toBeNull()
  })
  it('谁在拖：只算源头节点，按部门汇总自身延误天数，多的在前', () => {
    const r = lagByDept([
      { dept: 'TECH', state: 'SOURCE', selfDelayDays: 2 },
      { dept: 'PURCHASE', state: 'SOURCE', selfDelayDays: 4 },
      { dept: 'TECH', state: 'SOURCE', selfDelayDays: 1 },
      { dept: 'PRODUCTION', state: 'UPSTREAM', selfDelayDays: 0 },
    ])
    expect(r).toEqual([
      { dept: 'PURCHASE', days: 4, nodes: 1 },
      { dept: 'TECH', days: 3, nodes: 2 },
    ])
  })
})

describe('月份刻度跨年带年份', () => {
  it('抽稀后跳过 1 月时，跨年后的第一个刻度仍带年份', () => {
    const t = monthTicks({ start: '2026-01-15', end: '2027-12-20' })
    const y2027 = t.find((x) => x.label.startsWith('2027'))
    expect(y2027).toBeTruthy()
    expect(t[0]!.label.startsWith('2026')).toBe(true)
    expect(t.filter((x) => /年/.test(x.label))).toHaveLength(2)
  })
})

describe('圆点省略 compactIndexes / shortName', () => {
  it('不超过上限全显示', () => {
    expect(compactIndexes(5, 7)).toEqual([0, 1, 2, 3, 4])
  })
  it('超过上限保留头尾、中间一个省略号', () => {
    expect(compactIndexes(11, 7)).toEqual([0, 1, 2, null, 8, 9, 10])
  })
  it('卡点在中间时一定显示', () => {
    const r = compactIndexes(11, 7, 5)
    expect(r).toContain(5)
    expect(r).toEqual([0, 1, null, 5, null, 9, 10])
  })
  it('无论卡点在哪，总格数不超过上限且卡点可见', () => {
    for (const [count, max] of [[11, 7], [20, 7], [8, 7], [12, 6], [9, 5]] as const) {
      for (let keep = 0; keep < count; keep++) {
        const r = compactIndexes(count, max, keep)
        expect(r.length).toBeLessThanOrEqual(max)
        expect(r).toContain(keep)
        expect(r[0]).toBe(0)
        expect(r.at(-1)).toBe(count - 1)
      }
    }
  })
  it('名称缩写', () => {
    expect(shortName('关键物料到货')).toBe('关键物料')
    expect(shortName(' 评审 ')).toBe('评审')
  })
})

describe('boardGroup 项目总览分组', () => {
  const base = { hasPlan: true, delayDays: 0, delayedPlanNodes: 0, color: 'GREEN' as const }
  it('没有已发布总计划 → 未建总计划（哪怕是红的）', () => {
    expect(boardGroup({ ...base, hasPlan: false, color: 'RED' })).toBe('NO_PLAN')
  })
  it('拖期 > 0 → 预计拖期', () => {
    expect(boardGroup({ ...base, delayDays: 3 })).toBe('LATE')
  })
  it('有源头延误节点或红黄 → 有风险', () => {
    expect(boardGroup({ ...base, delayedPlanNodes: 1 })).toBe('RISK')
    expect(boardGroup({ ...base, color: 'YELLOW' })).toBe('RISK')
    expect(boardGroup({ ...base, delayDays: -2 })).toBe('OK')
  })
})

describe('sortActions 要处理的事', () => {
  it('红 → 黄 → 提醒；同级按天数多的在前，再预警在前', () => {
    const r = sortActions([
      { kind: 'issue' as const, level: 'YELLOW' as const, weight: 0, id: 1 },
      { kind: 'alert' as const, level: 'REMIND' as const, weight: 9, id: 2 },
      { kind: 'issue' as const, level: 'RED' as const, weight: 2, id: 3 },
      { kind: 'alert' as const, level: 'RED' as const, weight: 2, id: 4 },
      { kind: 'alert' as const, level: 'RED' as const, weight: 5, id: 5 },
    ])
    expect(r.map((x) => x.id)).toEqual([5, 4, 3, 1, 2])
  })
})

describe('甘特刻度与位置', () => {
  it('dayNum / numDay 互逆，跨月', () => {
    expect(numDay(dayNum('2026-02-28') + 1)).toBe('2026-03-01')
  })
  it('范围两头留白，至少 minSpan 天', () => {
    expect(ganttRange(['2026-10-10', '2026-10-12'], '2026-10-19', 2, 30)).toEqual({ start: '2026-10-08', end: '2026-11-07' })
    expect(ganttRange([null, undefined], '2026-10-19', 0, 10)).toEqual({ start: '2026-10-19', end: '2026-10-29' })
  })
  it('位置按天线性，超出范围夹到两端', () => {
    const r = { start: '2026-10-01', end: '2026-10-11' }
    expect(pct('2026-10-06', r)).toBe(50)
    expect(pct('2026-09-01', r)).toBe(0)
    expect(pct('2026-12-01', r)).toBe(100)
  })
  it('月份刻度：每月 1 号，第一个和跨年 1 月带年份', () => {
    const t = monthTicks({ start: '2026-11-15', end: '2027-02-10' })
    expect(t.map((x) => x.label)).toEqual(['2026 年 12 月', '2027 年 1 月', '2 月'])
    expect(t[0]!.left).toBeGreaterThan(0)
    // 开头正好是 1 号也算一个刻度
    expect(monthTicks({ start: '2026-08-01', end: '2026-09-15' }).map((x) => x.label)).toEqual(['2026 年 8 月', '9 月'])
  })
  it('月份太多时隔月显示', () => {
    expect(monthTicks({ start: '2026-01-15', end: '2027-12-20' }, 8).length).toBeLessThanOrEqual(8)
  })
  it('节点区间从上一节点接过来，第一个从开始日起；顺序和日期对不上时夹成一天', () => {
    const b = nodeBars(
      [
        { planDay: '2026-10-10', endDay: '2026-10-12' },
        { planDay: '2026-10-20', endDay: '2026-10-25' },
        { planDay: '2026-10-18', endDay: '2026-10-24' },
      ],
      '2026-10-01',
    )
    expect(b[0]).toEqual({ planFrom: '2026-10-01', planTo: '2026-10-10', from: '2026-10-01', to: '2026-10-12' })
    expect(b[1]).toEqual({ planFrom: '2026-10-10', planTo: '2026-10-20', from: '2026-10-12', to: '2026-10-25' })
    expect(b[2]).toEqual({ planFrom: '2026-10-18', planTo: '2026-10-18', from: '2026-10-24', to: '2026-10-24' })
  })
  it('交期对比条：预计超出合同交期时轴延长，超出天数；已用工期百分比', () => {
    const b = deliveryBar('2026-10-01', '2026-10-11', '2026-10-21', '2026-10-31')
    expect(b.usedPercent).toBe(50)
    expect(b.overDays).toBe(10)
    expect(b.today).toBe(33.33)
    expect(b.delivery).toBe(66.67)
    expect(b.expected).toBe(100)
    const ok = deliveryBar('2026-10-01', '2026-10-11', '2026-10-21', '2026-10-15')
    expect(ok.overDays).toBe(0)
    expect(ok.delivery).toBe(100)
    // 今天已过合同交期：已用工期封顶 100
    expect(deliveryBar('2026-10-01', '2026-11-11', '2026-10-21', null).usedPercent).toBe(100)
  })
})

describe('工单详情小规则', () => {
  it('总装节点：名称含"总装"优先，否则需求日最晚', () => {
    expect(pickMainAssembly([])).toBeNull()
    expect(pickMainAssembly([{ name: '部装 A', needDay: '2026-12-01' }, { name: '总装', needDay: '2026-11-01' }])?.name).toBe('总装')
    expect(pickMainAssembly([{ name: '部装 A', needDay: '2026-12-01' }, { name: '部装 B', needDay: '2026-11-01' }])?.name).toBe('部装 A')
  })
  it('缺件原因分布', () => {
    expect(reasonCounts([{ reason: '待料' }, { reason: '等图纸' }, { reason: '待料' }])).toEqual([
      { reason: '待料', count: 2 },
      { reason: '等图纸', count: 1 },
    ])
  })
  it('挂靠记录跳转带工单筛选', () => {
    expect(taskListLink('drawing', 'WO 1', 'x')).toBe('/drawings?wo=WO%201&view=all')
    expect(taskListLink('purchase', 'W', 'x')).toBe('/purchases?wo=W&view=all')
    expect(taskListLink('step', 'W', 'x')).toBe('/parts?wo=W')
    expect(taskListLink('assembly', 'W', 'n1')).toBe('/kitting?wo=W&id=n1')
    // 其他任务（部门计划二次分解）没有单独页面：到工单详情总计划页签定位节点
    expect(taskListLink('task', 'WO 1', 'k1', 'n1')).toBe('/plan?wo=WO%201&node=n1')
  })
  it('记录状态与付款文字（不含金额）', () => {
    expect(taskState({ done: true, excluded: false, overdue: true, lateForNode: true })).toBe('DONE')
    expect(taskState({ done: false, excluded: true, overdue: true, lateForNode: false })).toBe('EXCLUDED')
    expect(taskState({ done: false, excluded: false, overdue: true, lateForNode: true })).toBe('OVERDUE')
    expect(taskState({ done: false, excluded: false, overdue: false, lateForNode: true })).toBe('LATE')
    expect(paymentText([])).toBeNull()
    expect(paymentText(['PAID', 'PAID'])).toBe('已付')
    expect(paymentText(['PAID', 'ON_HOLD'])).toBe('付款未付')
  })
})
