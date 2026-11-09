import { describe, expect, it } from 'vitest'
import { forecastPlan } from '../../server/services/plan/forecast'
import type { NodeFacts } from '../../server/services/plan/estimate-types'

const nodes: NodeFacts[] = [
  { id: 'notice', planDay: '2026-10-01', startDay: '2026-10-01', manualDoneDay: null, tasks: [] },
  { id: 'drawing', planDay: '2026-11-23', startDay: '2026-10-02', manualDoneDay: null, tasks: [] },
]

describe('draft versus published forecasting', () => {
  it('does not age or propagate overdue draft dates, even after more time passes', () => {
    for (const today of ['2026-11-09', '2027-02-01']) {
      const result = forecastPlan(nodes, '2027-01-08', today, false)
      expect(result.nodes.map(n => n.expectedDay)).toEqual(['2026-10-01', '2026-11-23'])
      expect(result.nodes[1]?.preds).toEqual(['notice'])
      expect(result).toMatchObject({ expectedDelivery: null, deliveryDelayDays: null, sourceNodes: 0, delayedNodes: 0 })
      expect(result.nodes.every(n => n.delayDays === 0 && !n.source && !n.upstream)).toBe(true)
    }
  })
  it('starts execution forecasting when the same schedule is published', () => {
    const result = forecastPlan(nodes, '2027-01-08', '2026-11-09', true)
    expect(result.nodes[0]).toMatchObject({ expectedDay: '2026-11-09', delayDays: 39, source: true })
    expect(result.nodes[1]).toMatchObject({ expectedDay: '2027-01-01', upstream: true })
  })
})
