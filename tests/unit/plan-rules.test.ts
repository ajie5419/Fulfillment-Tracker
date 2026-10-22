/** 项目部总计划（R14）：部门任务预计日、节点顺延、自动完成、预计交期、W9 判定的纯函数 */
import { describe, expect, it } from 'vitest'
import {
  type NodeFacts,
  type TaskFacts,
  addDays,
  assemblyFacts,
  autoDone,
  drawingFacts,
  estimateNodes,
  estimateTask,
  forecastPlan,
  isPlanNodeAlert,
  judgeSplit,
  judgeW9,
  judgeW9Plan,
  lateWarning,
  planLink,
  planTaskFacts,
  purchaseFacts,
  stepFacts,
  w9PlanSummary,
  w9Summary,
} from '../../server/services/plan/constants'

const TODAY = '2026-10-19'
const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
const task = (over: Partial<TaskFacts> = {}): TaskFacts => ({ kind: 'drawing', id: 'T', excluded: false, done: false, doneDay: null, planDay: '2026-10-25', ...over })
const node = (id: string, planDay: string, tasks: TaskFacts[] = [], manualDoneDay: string | null = null): NodeFacts => ({ id, planDay, manualDoneDay, tasks })
const T9 = { remindHours: null, yellowDays: 1, redDays: 3 }

describe('addDays / planLink', () => {
  it('跨月、负数', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('提醒跳转地址 /plan?wo=…&node=…', () => {
    expect(planLink('WO 1', 'n1')).toBe('/plan?wo=WO%201&node=n1')
    expect(planLink('WO-1')).toBe('/plan?wo=WO-1')
  })
})

describe('部门任务预计日 estimateTask', () => {
  it('没完成、日期未到：预计 = 自己的日期；晚于节点日标出', () => {
    expect(estimateTask(task({ planDay: '2026-10-25' }), '2026-10-24', TODAY)).toEqual({ expectedDay: '2026-10-25', overdue: false, lateForNode: true })
    expect(estimateTask(task({ planDay: '2026-10-25' }), '2026-10-25', TODAY).lateForNode).toBe(false)
  })
  it('没完成、日期已过：按今天算，逾期', () => {
    expect(estimateTask(task({ planDay: '2026-10-10' }), '2026-10-30', TODAY)).toEqual({ expectedDay: TODAY, overdue: true, lateForNode: false })
  })
  it('已完成：预计 = 完成日（不知道按今天），不算逾期', () => {
    expect(estimateTask(task({ done: true, doneDay: '2026-10-12', planDay: '2026-10-10' }), '2026-10-30', TODAY)).toMatchObject({ expectedDay: '2026-10-12', overdue: false })
    expect(estimateTask(task({ done: true, doneDay: null }), '2026-10-30', TODAY).expectedDay).toBe(TODAY)
  })
  it('已取消不计；没有日期的不影响', () => {
    expect(estimateTask(task({ excluded: true, planDay: '2026-12-01' }), '2026-10-30', TODAY)).toEqual({ expectedDay: null, overdue: false, lateForNode: false })
    expect(estimateTask(task({ planDay: null }), '2026-10-30', TODAY).expectedDay).toBeNull()
  })
})

describe('各类记录换算 *Facts', () => {
  it('设计：设计完成等客户确认的看客户确认计划日；完成日取客户确认日', () => {
    const base = { id: 'D', status: 'CUSTOMER_PENDING' as const, planDate: d('2026-10-10'), drawnDate: d('2026-10-09'), needsCustomerConfirm: true, customerPlanDate: d('2026-10-20'), customerConfirmedDate: null }
    expect(drawingFacts(base)).toMatchObject({ done: false, planDay: '2026-10-20' })
    expect(drawingFacts({ ...base, status: 'DONE', customerConfirmedDate: d('2026-10-18') })).toMatchObject({ done: true, doneDay: '2026-10-18' })
    expect(drawingFacts({ ...base, status: 'CANCELLED' }).excluded).toBe(true)
    expect(drawingFacts({ ...base, status: 'PENDING', drawnDate: null }).planDay).toBe('2026-10-10')
  })
  it('采购：有承诺日看承诺日，否则需求日；到货算完成', () => {
    const base = { id: 'P', status: 'OPEN' as const, needDate: d('2026-10-20'), promisedDate: null, arrivedDate: null }
    expect(purchaseFacts(base).planDay).toBe('2026-10-20')
    expect(purchaseFacts({ ...base, promisedDate: d('2026-10-25') }).planDay).toBe('2026-10-25')
    expect(purchaseFacts({ ...base, status: 'ARRIVED', arrivedDate: d('2026-10-18') })).toMatchObject({ done: true, doneDay: '2026-10-18' })
  })
  it('工序：厂外外协有承诺返回日看承诺日；完成日按工厂时区', () => {
    const base = { id: 'S', status: 'OUT' as const, mode: 'EXTERNAL_OUTSOURCE' as const, dueDate: d('2026-10-20'), promisedReturnDate: d('2026-10-23'), finishedAt: null }
    expect(stepFacts(base, () => 'x').planDay).toBe('2026-10-23')
    expect(stepFacts({ ...base, mode: 'SELF', status: 'PENDING' }, () => 'x').planDay).toBe('2026-10-20')
    expect(stepFacts({ ...base, status: 'DONE', finishedAt: new Date('2026-10-18T20:00:00Z') }, () => '2026-10-19')).toMatchObject({ done: true, doneDay: '2026-10-19' })
  })
  it('装配节点：齐套算完成，完成日取记录的齐套日（不随今天变，晚于需求日也照实）；没有齐套日为 null；清单为空不算完成', () => {
    expect(assemblyFacts({ id: 'A', needDate: d('2026-10-25') }, { total: 2, ready: 2, readyDay: '2026-10-12' }, TODAY)).toMatchObject({ done: true, doneDay: '2026-10-12' })
    expect(assemblyFacts({ id: 'A', needDate: d('2026-10-10') }, { total: 2, ready: 2, readyDay: '2026-10-15' }, TODAY).doneDay).toBe('2026-10-15')
    expect(assemblyFacts({ id: 'A', needDate: d('2026-10-25') }, { total: 2, ready: 2 }, TODAY)).toMatchObject({ done: true, doneDay: null })
    expect(assemblyFacts({ id: 'A', needDate: d('2026-10-25') }, { total: 0, ready: 0 }, TODAY).done).toBe(false)
  })
})

describe('自动完成 autoDone', () => {
  it('计入的任务 ≥ 1 且全部完成 → 完成，完成日取最晚', () => {
    expect(autoDone([task({ done: true, doneDay: '2026-10-10' }), task({ done: true, doneDay: '2026-10-15' }), task({ excluded: true })], TODAY)).toEqual({ done: true, day: '2026-10-15' })
  })
  it('有没完成的、没有任务、只有已取消的 → 不算完成', () => {
    expect(autoDone([task({ done: true, doneDay: '2026-10-10' }), task()], TODAY).done).toBe(false)
    expect(autoDone([], TODAY).done).toBe(false)
    expect(autoDone([task({ excluded: true, done: true })], TODAY).done).toBe(false)
  })
})

describe('节点预计日与顺延 estimateNodes', () => {
  it('没有任务、计划日未到：预计 = 计划日，不晚', () => {
    const [n] = estimateNodes([node('A', '2026-10-25')], TODAY)
    expect(n).toMatchObject({ expectedDay: '2026-10-25', delayDays: 0, driver: 'self', done: false })
  })
  it('计划日已过还没完成：最早今天', () => {
    const [n] = estimateNodes([node('A', '2026-10-15')], TODAY)
    expect(n).toMatchObject({ expectedDay: TODAY, delayDays: 4, driver: 'today' })
  })
  it('挂靠任务晚于节点日：节点被推后，计数正确', () => {
    const [n] = estimateNodes([node('A', '2026-10-25', [task({ planDay: '2026-10-28' }), task({ planDay: '2026-10-10' }), task({ done: true, doneDay: '2026-10-01' })])], TODAY)
    expect(n).toMatchObject({ expectedDay: '2026-10-28', delayDays: 3, driver: 'task', taskCount: 3, doneCount: 1, overdueCount: 1, lateCount: 1 })
  })
  it('前序节点晚了，后续节点按原间隔顺延', () => {
    const est = estimateNodes(
      [node('A', '2026-10-25', [task({ planDay: '2026-10-29' })]), node('B', '2026-11-05'), node('C', '2026-11-20', [task({ planDay: '2026-11-30' })])],
      TODAY,
    )
    expect(est.map((n) => [n.expectedDay, n.delayDays, n.driver])).toEqual([
      ['2026-10-29', 4, 'task'],
      ['2026-11-09', 4, 'prev'],
      ['2026-11-30', 10, 'task'],
    ])
  })
  it('后续节点有余量（顺延后仍不晚于自己的计划日）就吸收掉', () => {
    const est = estimateNodes([node('A', '2026-10-25', [task({ planDay: '2026-10-27' })]), node('B', '2026-10-20')], TODAY)
    // B 的计划日早于 A（间隔为负）：顺延到 2026-10-22，仍晚于 B 计划日 → 晚 2 天
    expect(est[1]).toMatchObject({ expectedDay: '2026-10-22', delayDays: 2, driver: 'prev' })
  })
  it('完成的节点（手动优先于自动）：预计 = 实际，后续按实际顺延', () => {
    const est = estimateNodes(
      [node('A', '2026-10-10', [task({ done: true, doneDay: '2026-10-08' })], '2026-10-12'), node('B', '2026-10-30')],
      TODAY,
    )
    expect(est[0]).toMatchObject({ done: true, doneBy: 'MANUAL', actualDay: '2026-10-12', expectedDay: '2026-10-12', delayDays: 2, driver: 'actual' })
    expect(est[1]).toMatchObject({ expectedDay: '2026-11-01', delayDays: 2, driver: 'prev' })
    const auto = estimateNodes([node('A', '2026-10-10', [task({ done: true, doneDay: '2026-10-08' })])], TODAY)[0]
    expect(auto).toMatchObject({ done: true, doneBy: 'AUTO', actualDay: '2026-10-08', delayDays: -2 })
  })
})

describe('预计交期 forecastPlan', () => {
  it('最后一个节点的预计日；与 QMS 交期比得出拖期；延误节点数', () => {
    const f = forecastPlan([node('A', '2026-10-25', [task({ planDay: '2026-10-29' })]), node('B', '2026-11-30')], '2026-11-30', TODAY)
    expect(f).toMatchObject({ expectedDelivery: '2026-12-04', deliveryDelayDays: 4, delayedNodes: 2, sourceNodes: 1 })
  })
  it('不拖期为 0 或负；没有节点为 null', () => {
    expect(forecastPlan([node('A', '2026-11-20')], '2026-11-30', TODAY)).toMatchObject({ expectedDelivery: '2026-11-20', deliveryDelayDays: -10, delayedNodes: 0 })
    expect(forecastPlan([], '2026-11-30', TODAY)).toMatchObject({ expectedDelivery: null, deliveryDelayDays: null, delayedNodes: 0 })
  })
})

describe('源头节点 source / upstream', () => {
  it('自身延误的是源头；只因上游顺延的不是（标受上游影响）；自身也晚但更晚是上游推的：两者都标', () => {
    const est = estimateNodes(
      [
        node('A', '2026-10-25', [task({ planDay: '2026-10-29' })]), // 自身晚 4
        node('B', '2026-11-05'), // 只因顺延晚 4
        node('C', '2026-11-20', [task({ planDay: '2026-11-22' })]), // 自身晚 2，顺延晚 4
      ],
      TODAY,
    )
    expect(est.map((n) => [n.source, n.upstream, n.selfDelayDays, n.delayDays, n.selfDriver])).toEqual([
      [true, false, 4, 4, 'task'],
      [false, true, 0, 4, 'self'],
      [true, true, 2, 4, 'task'],
    ])
    expect(forecastPlan([node('A', '2026-10-25', [task({ planDay: '2026-10-29' })]), node('B', '2026-11-05')], '2026-11-30', TODAY)).toMatchObject({ delayedNodes: 2, sourceNodes: 1 })
  })
  it('计划日已过仍未完成：上游没推后时算自身延误（源头）；上游已经推过计划日时算受上游影响', () => {
    const [a] = estimateNodes([node('A', '2026-10-15')], TODAY)
    expect(a).toMatchObject({ source: true, selfDelayDays: 4, selfDriver: 'today' })
    const est = estimateNodes([node('A', '2026-10-10', [task({ planDay: '2026-10-25' })]), node('B', '2026-10-16')], TODAY)
    // B 计划日已过，但 A 预计 10-25，顺延到 10-31：B 不是源头
    expect(est[1]).toMatchObject({ source: false, upstream: true, expectedDay: '2026-10-31', selfDelayDays: 0 })
  })
  it('已完成的节点不是源头也不受上游影响', () => {
    const [a] = estimateNodes([node('A', '2026-10-10', [], '2026-10-14')], TODAY)
    expect(a).toMatchObject({ done: true, source: false, upstream: false, selfDelayDays: 4 })
  })
})

describe('W9 judgeW9 / judgeW9Plan / 摘要 / lateWarning', () => {
  it('节点级只报源头，按自身延误天数：1 天黄、3 天红', () => {
    expect(judgeW9({ source: true, selfDelayDays: 1 }, T9)).toBe('YELLOW')
    expect(judgeW9({ source: true, selfDelayDays: 2 }, T9)).toBe('YELLOW')
    expect(judgeW9({ source: true, selfDelayDays: 3 }, T9)).toBe('RED')
    expect(judgeW9({ source: false, selfDelayDays: 0 }, T9)).toBeNull()
    expect(judgeW9({ source: false, selfDelayDays: 5 }, T9)).toBeNull() // 已完成
  })
  it('黄阈值调大后晚 1 天不报', () => {
    expect(judgeW9({ source: true, selfDelayDays: 1 }, { remindHours: null, yellowDays: 2, redDays: 5 })).toBeNull()
  })
  it('工单级：预计交期晚于合同交期才报，红', () => {
    expect(judgeW9Plan(1)).toBe('RED')
    expect(judgeW9Plan(0)).toBeNull()
    expect(judgeW9Plan(-3)).toBeNull()
    expect(judgeW9Plan(null)).toBeNull()
  })
  it('摘要', () => {
    expect(w9Summary({ selfExpectedDay: '2026-11-06', selfDelayDays: 1, selfDriver: 'task', expectedDay: '2026-11-06', delayDays: 1 }, '2026-11-05')).toBe('计划 2026-11-05，预计 2026-11-06 完成，晚 1 天（部门任务延误）')
    expect(w9Summary({ selfExpectedDay: '2026-11-07', selfDelayDays: 2, selfDriver: 'task', expectedDay: '2026-11-09', delayDays: 4 }, '2026-11-05')).toBe(
      '计划 2026-11-05，预计 2026-11-07 完成，晚 2 天（部门任务延误）；加上游顺延预计 2026-11-09',
    )
    expect(w9PlanSummary('2026-11-30', { expectedDelivery: '2026-12-04', deliveryDelayDays: 4 }, ['设计出图', '关键物料到货'])).toBe(
      '合同交期 2026-11-30，按总计划预计 2026-12-04 交付，拖期 4 天；源头延误节点：设计出图、关键物料到货',
    )
  })
  it('部门日期晚于节点日才提示', () => {
    expect(lateWarning('需求日', '2026-10-27', { name: '装配', planDay: '2026-10-25' })).toContain('晚 2 天')
    expect(lateWarning('需求日', '2026-10-25', { name: '装配', planDay: '2026-10-25' })).toBeNull()
    expect(lateWarning('需求日', '2026-10-27', null)).toBeNull()
    expect(lateWarning('需求日', null, { name: '装配', planDay: '2026-10-25' })).toBeNull()
  })
})

describe('部门计划二次分解：其他任务 planTaskFacts / 未分解 judgeSplit', () => {
  it('其他任务：填了完成日 = 完成；看计划完成日；不会被排除', () => {
    expect(planTaskFacts({ id: 'K', planDate: d('2026-10-25'), doneDate: null })).toEqual({ kind: 'task', id: 'K', excluded: false, done: false, doneDay: null, planDay: '2026-10-25' })
    expect(planTaskFacts({ id: 'K', planDate: d('2026-10-25'), doneDate: d('2026-10-20') })).toMatchObject({ done: true, doneDay: '2026-10-20' })
  })

  it('其他任务和其他记录一样计入节点预计日、自动完成', () => {
    const late = planTaskFacts({ id: 'K', planDate: d('2026-10-28'), doneDate: null })
    const [n] = estimateNodes([node('N', '2026-10-25', [late])], TODAY)
    expect(n).toMatchObject({ expectedDay: '2026-10-28', driver: 'task', source: true, taskCount: 1 })
    const done = planTaskFacts({ id: 'K', planDate: d('2026-10-28'), doneDate: d('2026-10-18') })
    expect(estimateNodes([node('N', '2026-10-25', [done])], TODAY)[0]).toMatchObject({ done: true, doneBy: 'AUTO', actualDay: '2026-10-18' })
  })

  it('未分解：没完成、没有部门任务、发布后过了提醒小时数才提醒；提醒小时数为空不报', () => {
    const H = 3_600_000
    expect(judgeSplit({ done: false, taskCount: 0 }, 72 * H, 72)).toBe('REMIND')
    expect(judgeSplit({ done: false, taskCount: 0 }, 71 * H, 72)).toBeNull()
    expect(judgeSplit({ done: false, taskCount: 1 }, 100 * H, 72)).toBeNull()
    expect(judgeSplit({ done: true, taskCount: 0 }, 100 * H, 72)).toBeNull()
    expect(judgeSplit({ done: false, taskCount: 0 }, 100 * H, null)).toBeNull()
  })

  it('以节点为对象的 W9 预警类型只有一份清单', () => {
    expect(['planNode', 'planConfirm', 'planSplit'].every(isPlanNodeAlert)).toBe(true)
    expect(isPlanNodeAlert('plan')).toBe(false)
  })
})
