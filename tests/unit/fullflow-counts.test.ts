import { describe, expect, it } from 'vitest'
import { isDesignComplete } from '../../shared/drawing'
import { boardRiskSections, hasWorkOrderRisk } from '../../shared/status'
import { isOutside } from '../../shared/production'
import { deptNodeTab, drawingFacts } from '../../server/services/plan/constants'

it('counts design completion before release, excluding pending/cancelled tasks', () => {
  expect(['PENDING', 'DRAWN', 'CUSTOMER_PENDING', 'DONE', 'CANCELLED'].filter(isDesignComplete)).toEqual(['DRAWN', 'CUSTOMER_PENDING', 'DONE'])
  for (const status of ['DRAWN', 'CUSTOMER_PENDING', 'DONE'] as const) {
    expect(drawingFacts({ id: 'D', status, planDate: new Date('2026-10-01'), drawnDate: new Date('2026-10-02'), needsCustomerConfirm: false, customerPlanDate: null, customerConfirmedDate: null })).toMatchObject({ done: true, doneDay: '2026-10-02' })
  }
})

describe('distinct risk work orders', () => {
  const safe = { redAlerts: 0, yellowAlerts: 0, openIssues: 0, shortage: 0, incompleteNodes: 0, delayedPlanNodes: 0, delayDays: null }
  it.each(['redAlerts', 'yellowAlerts', 'openIssues', 'shortage', 'incompleteNodes', 'delayedPlanNodes', 'delayDays'])('includes %s independently of the exclusive board group', key => {
    expect(hasWorkOrderRisk({ ...safe, [key]: 1 })).toBe(true)
  })
  it('counts a work order once despite overlapping risks', () => {
    expect([safe, { ...safe, redAlerts: 9, yellowAlerts: 3, openIssues: 1, shortage: 1, delayDays: 4 }].filter(hasWorkOrderRisk)).toHaveLength(1)
  })
})

it('keeps external blocked operations in custody until returned; excludes unsent external tasks', () => {
  const row = { mode: 'EXTERNAL_OUTSOURCE', status: 'BLOCKED', startedAt: '2026-10-01', quantity: 4, doneQty: 1 }
  expect(isOutside(row)).toBe(true)
  expect(isOutside({ ...row, doneQty: 4 })).toBe(false)
  expect(isOutside({ ...row, status: 'PENDING', startedAt: null })).toBe(false)
  expect(isOutside({ ...row, mode: 'SELF' })).toBe(false)
  expect(isOutside({ ...row, status: 'OUT' })).toBe(true)
})

it('excludes returned nodes from pending acceptance', () => {
  const tabs = ['PENDING', 'PENDING', 'REJECTED', 'CONFIRMED'].map(confirmStatus => deptNodeTab({ done: false, confirmStatus }))
  expect(tabs.filter(t => t === 'pending')).toHaveLength(2)
  expect(tabs.filter(t => t === 'returned')).toHaveLength(1)
  expect(deptNodeTab({ done: true, confirmStatus: 'CONFIRMED' })).toBe('done')
})

it('includes a late work order with warnings in both sections and counts the union once', () => {
  const row = { workOrderNumber: 'DEMO-WO-001', delayDays: 4, redAlerts: 8, yellowAlerts: 5, openIssues: 0, shortage: 1, incompleteNodes: 1, delayedPlanNodes: 1 }
  const sections = boardRiskSections([row])
  expect(sections.LATE).toEqual([row])
  expect(sections.RISK).toEqual([row])
  const union = new Set([...sections.LATE, ...sections.RISK].map(r => r.workOrderNumber))
  expect(union.size).toBe([row].filter(hasWorkOrderRisk).length)
  expect(union.size).toBe(1)
})
