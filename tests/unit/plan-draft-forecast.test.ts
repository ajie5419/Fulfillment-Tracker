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
      const result = forecastPlan(nodes, '2027-01-08', today, new Set(), false)
      expect(result.nodes.map(n => n.expectedDay)).toEqual(['2026-10-01', '2026-11-23'])
      expect(result.nodes[1]?.preds).toEqual(['notice'])
      expect(result.nodes[1]?.expectedStartDay).toBe('2026-10-02')
      expect(result.dateConflicts).toEqual([])
      expect(result).toMatchObject({ expectedDelivery: null, deliveryDelayDays: null, sourceNodes: 0, delayedNodes: 0 })
      expect(result.nodes.every(n => n.delayDays === 0 && !n.source && !n.upstream)).toBe(true)
    }
  })
  it('starts execution forecasting when the same schedule is published', () => {
    const result = forecastPlan(nodes, '2027-01-08', '2026-11-09', new Set(), true)
    expect(result.nodes[0]).toMatchObject({ expectedDay: '2026-11-09', delayDays: 39, source: true })
    expect(result.nodes[1]).toMatchObject({ expectedDay: '2027-01-01', upstream: true })
  })
  it('keeps draft FS conflicts visible for publish validation without shifting dates', () => {
    const offDays = new Set(['2026-10-02', '2026-10-03'])
    const result = forecastPlan(nodes, '2027-01-08', '2027-02-01', offDays, false)
    expect(result.dateConflicts).toEqual([expect.objectContaining({ code: 'FS_ORDER', nodeId: 'drawing', blocksPublish: true })])
    expect(result.nodes[1]).toMatchObject({ dateConflict: true, expectedStartDay: '2026-10-02', expectedDay: '2026-11-23', delayDays: 0, source: false, upstream: false })
    expect(result.expectedDelivery).toBeNull()
  })
  it('retains historical completion conflicts in a draft while suppressing execution delay', () => {
    const result = forecastPlan(nodes.map(n => n.id === 'drawing' ? { ...n, manualDoneDay: '2026-09-30' } : n), '2027-01-08', '2026-11-09', new Set(), false)
    expect(result.dateConflicts.map(conflict => conflict.code)).toEqual(['ACTUAL_ORDER'])
    expect(result.sourceNodes).toBe(0)
    expect(result.delayedNodes).toBe(0)
  })
})
