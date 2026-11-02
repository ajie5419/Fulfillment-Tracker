import { describe, expect, it } from 'vitest'
import * as plan from '../../server/services/plan/constants'
import { shanghaiDay } from '../../server/services/alerts/rules'
import * as graph from '../../server/services/plan/graph'
import * as tasks from '../../server/services/plan/task-estimates'
import * as nodesModule from '../../server/services/plan/node-estimates'
import * as forecast from '../../server/services/plan/forecast'
import * as warnings from '../../server/services/plan/warnings'

const d = (day: string) => new Date(`${day}T00:00:00Z`)
const nodes: plan.NodeFacts[] = [
  { id: 'A', planDay: '2026-12-30', manualDoneDay: null, tasks: [{ kind: 'purchase', id: 'P', excluded: false, done: false, doneDay: null, planDay: '2027-01-02' }] },
  { id: 'B', planDay: '2026-12-31', manualDoneDay: null, tasks: [] },
]

describe('plan/constants 搬移前固定输入 / 固定输出', () => {
  it('旧 constants 入口与新职责模块导出相同函数本体', () => {
    for (const module of [graph, tasks, nodesModule, forecast, warnings]) {
      for (const [name, value] of Object.entries(module)) expect(Reflect.get(plan, name)).toBe(value)
    }
  })
  it('各任务事实、估算、排除、未知完成日及自动完成', () => {
    const facts = [
      plan.drawingFacts({ id: 'D', status: 'DRAWN', planDate: d('2026-12-30'), drawnDate: d('2026-12-29'), needsCustomerConfirm: true, customerPlanDate: d('2027-01-02'), customerConfirmedDate: null }),
      plan.purchaseFacts({ id: 'P', status: 'CANCELLED', needDate: d('2026-12-30'), promisedDate: null, arrivedDate: null }),
      plan.stepFacts({ id: 'S', status: 'DONE', mode: 'EXTERNAL_OUTSOURCE', dueDate: d('2026-12-30'), promisedReturnDate: d('2026-12-31'), finishedAt: new Date('2026-12-31T16:00:00Z') }, shanghaiDay),
      plan.assemblyFacts({ id: 'K', needDate: d('2027-01-02') }, { total: 2, ready: 2, readyDay: '2026-12-31' }, '2027-01-01'),
      plan.planTaskFacts({ id: 'T', planDate: d('2026-12-30'), doneDate: null }),
    ]
    expect({ facts, estimates: facts.map(t => plan.estimateTask(t, '2026-12-30', '2027-01-01')), auto: plan.autoDone(facts.filter(t => t.done), '2027-01-01') }).toMatchSnapshot()
  })

  it('前置、层级、拓扑、余量、影响范围、大纲与最后一级节点', () => {
    const input = [...nodes, { id: 'C', parent: 'A', preds: ['B', 'A', 'C', 'missing'] }]
    const ordered = plan.treeOrder(input)
    const preds = plan.resolvePreds(ordered)
    const kids = plan.childrenOf(ordered)
    const waits = plan.waitsOn(preds, kids)
    expect({ order: ordered.map(n => n.id), parents: plan.parentsOf(input), preds, kids, waits, topo: plan.topoOrder(ordered.map(n => n.id), waits),
      last: plan.lastTopNode(input)?.id, float: plan.linkFloat('2026-12-30', '2027-01-02'),
      downstream: plan.downstreamOf([{ id: 'A', preds: [], children: ['C'] }, { id: 'C', preds: ['B'], children: [] }, { id: 'B', preds: [], children: [] }]),
      outline: plan.outlineCodes([{ id: 'A', parentId: null, phase: '阶段' }, { id: 'C', parentId: 'A', phase: '阶段' }, { id: 'B', parentId: null, phase: '阶段' }]),
    }).toMatchSnapshot()
  })

  it('源头延误、顺延、余量与交期预测', () => {
    expect(plan.forecastPlan(nodes, '2026-12-31', '2026-12-29')).toMatchSnapshot()
  })

  it('环兜底仍按原顺序一条主线估算', () => {
    expect(plan.estimateNodes(nodes.map(n => ({ ...n, preds: [n.id === 'A' ? 'B' : 'A'] })), '2026-12-29')).toMatchSnapshot()
  })

  it('预警级别与文案', () => {
    const estimate = plan.forecastPlan(nodes, '2026-12-31', '2026-12-29')
    const first = estimate.nodes[0]!
    expect({ critical: estimate.nodes.map(plan.isCritical), delayed: estimate.nodes.map(plan.isDelayed),
      w9: plan.judgeW9(first, { remindHours: 72, yellowDays: 1, redDays: 3 }), plan: plan.judgeW9Plan(estimate.deliveryDelayDays),
      summary: plan.w9Summary(first, nodes[0]!.planDay), delivery: plan.w9PlanSummary('2026-12-31', estimate, ['采购']),
      split: plan.judgeSplit({ done: false, taskCount: 0 }, 72 * 3_600_000, 72),
      warning: plan.lateWarning('到货日', '2027-01-02', { name: '采购', planDay: '2026-12-30' }),
    }).toMatchSnapshot()
  })
})
