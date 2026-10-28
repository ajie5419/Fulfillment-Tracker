import type { Part, RouteStep } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  part: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  routeStep: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  flowEvent: { findUnique: vi.fn(), create: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  todo: { updateMany: vi.fn() },
  drawingTaskPart: { findMany: vi.fn() },
  purchaseLine: { findMany: vi.fn() },
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
vi.mock('../../server/services/alerts/clear', () => ({ clearAlertKeys: vi.fn() }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ process: new Map([['process', 'Final process']]) }) }))
vi.mock('../../server/services/purchases/purchases', () => ({ readyOwners: async () => [], refreshPartReady: vi.fn() }))

import { blockStep, recordReturn, restoreBlockedStep } from '../../server/services/flow/flow'
import { deleteStep, syncFirstStep } from '../../server/services/flow/steps'
import { loadKitCounts, loadKits, type NodeWithLinks } from '../../server/services/kitting/kitting'

let part: Part
let steps: RouteStep[]
let events: { stepId: string; type: string; qty: number }[]
const tx = db as never
const node = { id: 'node', parts: [{ partId: 'part' }], purchases: [], needDate: new Date('2026-12-01') } as unknown as NodeWithLinks
const kit = async () => (await loadKits([node], new Date())).get(node.id)!
const returned = (stepId = 'last', qty = 2) => recordReturn(tx, { stepId, qty, source: 'QMS_INSPECTION', occurredAt: new Date() })

/** Simulate stored rows while exercising the real flow and kitting services; this is not a database-lock test. */
beforeEach(() => {
  vi.resetAllMocks()
  part = { id: 'part', status: 'ACTIVE', currentStepId: 'last', quantity: 2, name: 'Part', drawingNo: null, statusSince: new Date('2026-10-01') } as Part
  steps = [{ id: 'last', partId: part.id, seq: 1, status: 'OUT', mode: 'EXTERNAL_OUTSOURCE', processId: 'process' } as RouteStep]
  events = []
  db.$transaction.mockImplementation((fn) => fn(db))
  db.$queryRaw.mockImplementation(async (_sql, id) => steps.filter((s) => s.id === id).map((s) => ({ status: s.status })))
  db.routeStep.findUnique.mockImplementation(async ({ where }) => ({ ...steps.find((s) => s.id === where.id)!, part: { ...part } }))
  db.routeStep.findFirst.mockImplementation(async ({ where }) => steps.filter((s) => s.partId === where.partId && (!where.seq || s.seq > where.seq.gt)).sort((a, b) => a.seq - b.seq)[0] ?? null)
  db.routeStep.update.mockImplementation(async ({ where, data }) => Object.assign(steps.find((s) => s.id === where.id)!, data))
  db.routeStep.findMany.mockImplementation(async ({ where }) => steps.filter((s) => s.partId === where.partId).map((s) => ({ ...s })))
  db.routeStep.delete.mockImplementation(async ({ where }) => { steps = steps.filter((s) => s.id !== where.id) })
  db.part.findUnique.mockImplementation(async () => ({ ...part }))
  db.part.update.mockImplementation(async ({ data }) => Object.assign(part, data))
  db.part.updateMany.mockImplementation(async ({ where, data }) => {
    if (part.id !== where.id || part.status !== where.status) return { count: 0 }
    Object.assign(part, data)
    return { count: 1 }
  })
  db.part.findMany.mockImplementation(async ({ select }) => [{ ...part, ...(select.steps ? { steps: steps.map((s) => ({ ...s })) } : {}) }])
  db.flowEvent.findUnique.mockResolvedValue(null)
  db.flowEvent.count.mockImplementation(async ({ where }) => events.filter((e) =>
    (typeof where.stepId === 'string' ? e.stepId === where.stepId : where.stepId.in.includes(e.stepId)) &&
    (!where.type || (typeof where.type === 'string' ? e.type === where.type : where.type.in.includes(e.type))),
  ).length)
  db.flowEvent.aggregate.mockImplementation(async ({ where }) => ({ _sum: { qty: events.filter((e) => e.stepId === where.stepId && where.type.in.includes(e.type)).reduce((sum, e) => sum + e.qty, 0) } }))
  db.flowEvent.create.mockImplementation(async ({ data }) => { events.push(data); return data })
  db.drawingTaskPart.findMany.mockResolvedValue([])
  db.purchaseLine.findMany.mockResolvedValue([])
})

describe('part completion and kitting after nonconformance', () => {
  it('withdraws readiness after a final return is rejected, then restores it after recovery', async () => {
    await returned()
    expect(part.status).toBe('DONE')
    expect(await kit()).toMatchObject({ ready: 1, percent: 100, shortages: [] })
    await blockStep(tx, 'last')
    expect(part.status).toBe('ACTIVE')
    expect(await kit()).toMatchObject({ ready: 0, percent: 0, incomplete: true, shortages: [{ reasonCode: 'BLOCKED' }] })
    expect((await loadKitCounts([node])).get(node.id)).toMatchObject({ ready: 0, readyDay: null })
    await restoreBlockedStep(tx, 'last')
    expect(part.status).toBe('DONE')
    expect(await kit()).toMatchObject({ ready: 1, percent: 100, shortages: [] })
  })

  it('does not complete a part when a later step finishes while an earlier step is blocked', async () => {
    steps.unshift({ ...steps[0]!, id: 'earlier', seq: 0, status: 'BLOCKED' })
    await returned()
    expect(steps[1]!.status).toBe('DONE')
    expect(part.status).toBe('ACTIVE')
    expect(await kit()).toMatchObject({ ready: 0, shortages: [{ reasonCode: 'BLOCKED' }] })
  })

  it('waits for every step when work finishes out of order', async () => {
    steps.unshift({ ...steps[0]!, id: 'earlier', seq: 0, status: 'OUT' })
    await returned()
    expect(part.status).toBe('ACTIVE')
    await returned('earlier')
    expect(part.status).toBe('DONE')
  })

  it('does not restore completion while another step is still blocked', async () => {
    await returned()
    steps.unshift({ ...steps[0]!, id: 'earlier', seq: 0 })
    events.push({ stepId: 'earlier', type: 'RETURN', qty: 2 })
    await blockStep(tx, 'earlier')
    await blockStep(tx, 'last')
    await restoreBlockedStep(tx, 'last')
    expect(part.status).toBe('ACTIVE')
    await restoreBlockedStep(tx, 'earlier')
    expect(part.status).toBe('DONE')
  })

  it('keeps a partially returned step and its part incomplete after recovery', async () => {
    await returned('last', 1)
    await blockStep(tx, 'last')
    expect(await restoreBlockedStep(tx, 'last')).toBe('OUT')
    expect(part.status).toBe('ACTIVE')
    expect(await kit()).toMatchObject({ ready: 0 })
  })

  it('does not change the completion date on repeated recovery or blocking', async () => {
    await returned()
    await blockStep(tx, 'last')
    const blockedSince = part.statusSince
    expect(await blockStep(tx, 'last')).toBe(false)
    expect(part.statusSince).toBe(blockedSince)
    await restoreBlockedStep(tx, 'last')
    const doneSince = part.statusSince
    expect(await restoreBlockedStep(tx, 'last')).toBeNull()
    expect(part.statusSince).toBe(doneSince)
  })

  it('excludes legacy DONE parts with blocked steps from both counts and shortages', async () => {
    part.status = 'DONE'
    steps[0]!.status = 'BLOCKED'
    expect(await kit()).toMatchObject({ ready: 0, percent: 0, shortages: [{ reasonCode: 'BLOCKED' }] })
    expect((await loadKitCounts([node])).get(node.id)).toMatchObject({ ready: 0, readyDay: null })
    expect(part.status).toBe('DONE')
    expect(db.part.updateMany).not.toHaveBeenCalled()
  })

  it('records the recovery date for a legacy DONE part whose blocked process is not its current process', async () => {
    part.status = 'DONE'
    steps[0]!.status = 'DONE'
    steps.unshift({ ...steps[0]!, id: 'earlier', seq: 0, status: 'BLOCKED' })
    events.push({ stepId: 'earlier', type: 'RETURN', qty: 2 })
    const oldCompletion = part.statusSince.getTime()
    await restoreBlockedStep(tx, 'earlier')
    expect(part.status).toBe('DONE')
    expect(part.statusSince.getTime()).toBeGreaterThan(oldCompletion)
  })

  it('completes the part when its only unfinished, unused process is deleted', async () => {
    steps.unshift({ ...steps[0]!, id: 'earlier', seq: 0, status: 'PENDING' })
    await returned()
    expect(part.status).toBe('ACTIVE')
    await deleteStep('earlier')
    expect(part.status).toBe('DONE')
    expect(await kit()).toMatchObject({ ready: 1, percent: 100 })
  })

  it('keeps a part without any remaining processes incomplete', async () => {
    steps[0]!.status = 'PENDING'
    await deleteStep('last')
    expect(part.status).toBe('ACTIVE')
    expect(await kit()).toMatchObject({ ready: 0, shortages: [{ reasonCode: 'NO_ROUTE' }] })
  })

  it('withdraws completion after a route is appended even when its first process does not change', async () => {
    await returned()
    const first = { ...steps[0]! }
    steps.push({ ...first, id: 'appended', seq: 2, status: 'PENDING' })
    await syncFirstStep(tx, part.id, 'WO', first)
    expect(part.status).toBe('ACTIVE')
    expect(await kit()).toMatchObject({ ready: 0 })
  })
})
