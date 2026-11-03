import { describe, expect, it } from 'vitest'
import { forecastPlan } from '../../server/services/plan/forecast'
import type { NodeFacts } from '../../server/services/plan/estimate-types'

const node = (id: string, startDay: string | null, planDay: string, preds: string[] = []): NodeFacts => ({ id, name: id, startDay, planDay, preds, manualDoneDay: null, tasks: [] })
const today = '2026-11-01'

describe('FS 日期冲突及真实计算输出', () => {
  it('截图：12-24 通知之后图纸不能仍预计 11-29，冲突不能显示正常交期及四天余量', () => {
    const result = forecastPlan([node('开工通知', '2026-11-03', '2026-12-24'), node('图纸', '2026-11-04', '2026-11-29', ['开工通知'])], '2026-12-03', today)
    expect(result.dateConflicts).toEqual([expect.objectContaining({ code: 'FS_ORDER', nodeId: '图纸', blocksPublish: true })])
    expect(result.nodes[1]).toMatchObject({ expectedStartDay: '2026-12-25', expectedDay: '2027-01-19', slackDays: null })
    expect(result.expectedDelivery).toBeNull()
    expect(result.deliveryDelayDays).toBeNull()
    expect(result.nodes.every((entry) => entry.slackDays === null)).toBe(true)
  })

  it('延期链与多前置取最晚预计完成，保留自然日工期', () => {
    const first = { ...node('A', '2026-11-01', '2026-11-03'), tasks: [{ kind: 'task' as const, id: 't', excluded: false, done: false, doneDay: null, planDay: '2026-11-06' }] }
    const result = forecastPlan([first, node('B', '2026-11-01', '2026-11-05'), node('C', '2026-11-06', '2026-11-08', ['A', 'B']), node('D', '2026-11-09', '2026-11-10', ['C'])], '2026-11-20', today)
    expect(result.dateConflicts).toEqual([])
    expect(result.nodes[2]).toMatchObject({ expectedStartDay: '2026-11-07', expectedDay: '2026-11-09' })
    expect(result.nodes[3]).toMatchObject({ expectedStartDay: '2026-11-10', expectedDay: '2026-11-11' })
    expect(result.expectedDelivery).toBe('2026-11-11')
  })

  it('FS 禁止同日，跨配置停工日；周末本身不自动排除', () => {
    const input = [node('A', '2026-11-01', '2026-11-06'), node('B', '2026-11-06', '2026-11-08', ['A'])]
    expect(forecastPlan(input, '2026-11-20', today).nodes[1]).toMatchObject({ expectedStartDay: '2026-11-07', expectedDay: '2026-11-09' })
    const result = forecastPlan(input, '2026-11-20', today, new Set(['2026-11-07', '2026-11-08']))
    expect(result.nodes[1]).toMatchObject({ expectedStartDay: '2026-11-09', expectedDay: '2026-11-11' })
    expect(result.dateConflicts[0]?.code).toBe('FS_ORDER')
  })

  it('已完成事实不因前置未完成而改写，但必须提示核实', () => {
    const result = forecastPlan([node('A', null, '2026-11-03'), { ...node('B', '2026-11-04', '2026-11-06', ['A']), manualDoneDay: '2026-10-31' }], '2026-11-20', today)
    expect(result.nodes[1]).toMatchObject({ actualDay: '2026-10-31', expectedDay: '2026-10-31', done: true })
    expect(result.dateConflicts.map((conflict) => conflict.code)).toContain('ACTUAL_ORDER')
    expect(result.expectedDelivery).toBeNull()
  })

  it('旧数据缺开始日明确待核实，不把兼容预测当有效交期', () => {
    const result = forecastPlan([node('A', null, '2026-11-03'), node('B', null, '2026-11-06', ['A'])], '2026-11-20', today)
    expect(result.dateConflicts.map((conflict) => conflict.code)).toEqual(['MISSING_START'])
    expect(result.expectedDelivery).toBeNull()
    expect(result.nodes[1]?.slackDays).toBeNull()
  })

  it('无依赖并行不误报，交付仍取末一级而不是最晚节点', () => {
    const result = forecastPlan([node('并行', null, '2026-12-30'), node('交付', null, '2026-11-20')], '2026-11-21', today)
    expect(result.dateConflicts).toEqual([])
    expect(result.expectedDelivery).toBe('2026-11-20')
    expect(result.nodes[0]?.slackDays).toBeNull()
    expect(result.nodes[1]?.slackDays).toBe(1)
  })

  it('子节点前置延期经汇总节点继续传递，不把汇总当额外 FS 工期', () => {
    const result = forecastPlan([node('A', null, '2026-11-10'), node('P', null, '2026-11-12'), { ...node('子项', '2026-11-03', '2026-11-05', ['A']), parent: 'P' }, node('交付', '2026-11-13', '2026-11-14', ['P'])], '2026-11-20', today)
    expect(result.nodes[2]).toMatchObject({ expectedStartDay: '2026-11-11', expectedDay: '2026-11-13' })
    expect(result.nodes[1]?.expectedDay).toBe('2026-11-13')
    expect(result.nodes[3]?.expectedDay).toBe('2026-11-15')
    expect(result.expectedDelivery).toBeNull()
  })
})
