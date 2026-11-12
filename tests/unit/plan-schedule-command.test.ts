import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanNode } from '@prisma/client'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'
import { parseDay } from '../../shared/dates'
import type { ScheduleNode } from '../../server/services/plan/schedule'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/plan/schedule-preview', async (original) => ({ ...await original<object>(), scheduleSnapshot: vi.fn() }))
vi.mock('../../server/services/plan/queries', () => ({ loadPlans: vi.fn() }))
import { schedulePreview, scheduleSnapshot } from '../../server/services/plan/schedule-preview'
import { updateNode } from '../../server/services/plan/commands'
import { loadPlans } from '../../server/services/plan/queries'
import { forecastPlan } from '../../server/services/plan/forecast'
import { prisma } from '../../server/utils/prisma'

const row: PlanNode = {
  id: 'a', workOrderNumber: 'WO', name: '采购计划', dept: 'TECH', parentId: null, phase: null, seq: 1,
  planDate: parseDay('2026-11-05'), startDate: parseDay('2026-11-01'), requiresProcess: true, customDeps: true,
  baselineDate: null, actualDate: null, manualDoneAt: null, manualDoneBy: null, confirmStatus: null,
  confirmedBy: null, confirmedAt: null, rejectReason: null, note: null,
  createdAt: parseDay('2026-11-01'), updatedAt: parseDay('2026-11-01'),
}
let snapshot: ScheduleNode[]
let published = false
let offDays: Set<string>
let editedFinish: string
const input = { planDate: parseDay('2026-11-10'), linkedDates: true }
beforeEach(() => {
  resetServiceDb()
  published = false
  offDays = new Set()
  editedFinish = '2026-11-10'
  snapshot = [
    { id: 'a', name: '采购计划', parent: null, preds: [], start: '2026-11-01', finish: '2026-11-05', done: false },
    { id: 'b', name: '采购及复验', parent: null, preds: ['a'], start: '2026-11-06', finish: '2026-11-08', done: false },
  ]
  vi.mocked(scheduleSnapshot).mockImplementation(async () => {
    const candidate = method('planNode.update').mock.calls.length > 0
    return {
      nodes: snapshot.map((n) => ({ ...n, ...(candidate && n.id === 'a' ? { finish: editedFinish } : {}) })),
      offDays: new Set(offDays),
      version: { nodes: [], tasks: [], deps: [], status: published ? 'PUBLISHED' : 'DRAFT', offDays: [...offDays].sort() },
    }
  })
  vi.mocked(loadPlans).mockResolvedValue(new Map())
  returns('planNode.findUnique', row)
  returns('workOrderPlan.upsert', {})
  method('workOrderPlan.findUniqueOrThrow').mockImplementation(async () => ({ status: published ? 'PUBLISHED' : 'DRAFT' }))
  returns('$queryRaw', [])
  returns('planNode.count', 0)
  method('planNode.update').mockImplementation(async ({ where, data }) => ({ ...row, id: where.id, ...data }))
  returns('planNode.findMany', [{ id: 'a' }, { id: 'b' }])
  returns('planChangeLog.create', {})
  returns('notifyRole.findMany', [{ userId: 'head' }])
  returns('todo.createMany', { count: 1 })
  returns('todo.updateMany', { count: 1 })
  returns('alert.updateMany', { count: 1 })
})

describe('linked date command transaction', () => {
  it('rolls back previews without notifications or audit writes, then applies the exact preview', async () => {
    const preview = (await updateNode('a', { ...input, preview: true }, 'pm')).preview!
    expect(preview.changes).toHaveLength(2)
    expect(preview.changes[1]).toMatchObject({ start: '2026-11-11', finish: '2026-11-13' })
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    expect(method('todo.createMany')).not.toHaveBeenCalled()
    expect(method('planChangeLog.create')).not.toHaveBeenCalled()
    method('planNode.update').mockClear()
    await updateNode('a', { ...input, previewToken: preview.token }, 'pm')
    expect(method('planNode.update')).toHaveBeenCalledWith({ where: { id: 'b' }, data: { startDate: parseDay('2026-11-11'), planDate: parseDay('2026-11-13') } })
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })
  it('rejects absent or stale preview tokens and rolls back the initiating edit', async () => {
    await expect(updateNode('a', input, 'pm')).rejects.toThrow('重新预览')
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    method('planNode.update').mockClear()
    const preview = (await updateNode('a', { ...input, preview: true }, 'pm')).preview!
    method('planNode.update').mockClear()
    snapshot[1]!.finish = '2026-11-09'
    await expect(updateNode('a', { ...input, previewToken: preview.token }, 'pm')).rejects.toThrow('重新预览')
    expect(method('todo.createMany')).not.toHaveBeenCalled()
  })
  it('previews and commits the same next working day across configured shutdowns', async () => {
    editedFinish = '2026-11-06'
    offDays = new Set(['2026-11-07', '2026-11-08'])
    const edit = { ...input, planDate: parseDay(editedFinish) }
    const preview = (await updateNode('a', { ...edit, preview: true }, 'pm')).preview!
    expect(preview.changes[1]).toMatchObject({ start: '2026-11-09', finish: '2026-11-11' })
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    method('planNode.update').mockClear()
    await updateNode('a', { ...edit, previewToken: preview.token }, 'pm')
    expect(method('planNode.update')).toHaveBeenCalledWith({ where: { id: 'b' }, data: { startDate: parseDay('2026-11-09'), planDate: parseDay('2026-11-11') } })
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })
  it('rejects an old preview when the factory calendar changes even outside the moved dates', async () => {
    const preview = (await updateNode('a', { ...input, preview: true }, 'pm')).preview!
    method('planNode.update').mockClear()
    offDays.add('2026-12-25')
    await expect(updateNode('a', { ...input, previewToken: preview.token }, 'pm')).rejects.toThrow('重新预览')
    expect(method('planNode.update').mock.calls.every(([arg]) => arg.where.id === 'a')).toBe(true)
    expect(method('todo.createMany')).not.toHaveBeenCalled()
    expect(method('planChangeLog.create')).not.toHaveBeenCalled()
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
  })
  it('requires a published reason and logs both dates without truncating it', async () => {
    published = true
    await expect(updateNode('a', { ...input, preview: true }, 'pm')).rejects.toThrow('原因')
    const reason = 'r'.repeat(500)
    const preview = (await updateNode('a', { ...input, reason, preview: true }, 'pm')).preview!
    method('planNode.update').mockClear()
    const result = await updateNode('a', { ...input, reason, previewToken: preview.token }, 'pm')
    expect(result.reconfirm).toBe(true)
    expect(method('planChangeLog.create').mock.calls.map(([arg]) => [arg.data.nodeId, arg.data.kind, arg.data.reason])).toEqual([
      ['b', 'DATE', reason], ['b', 'START', reason], ['a', 'DATE', reason],
    ])
    expect(method('todo.createMany')).toHaveBeenCalledTimes(2)
  })
  it('previews and persists completed summary dates and downstream dates without editing completed leaves', async () => {
    published = true
    const reason = 'Correct the completed child plan dates'
    const child = { ...row, parentId: 'parent', planDate: parseDay('2026-11-03'), startDate: parseDay('2026-11-02') }
    const parent = { ...child, id: 'parent', name: 'Summary', parentId: null }
    method('planNode.findUnique').mockImplementation(async ({ where }) => where.id === 'a' ? child : parent)
    method('planNode.update').mockImplementation(async ({ where, data }) => ({ ...(where.id === 'a' ? child : row), id: where.id, ...data }))
    snapshot = [
      { id: 'parent', name: 'Summary', parent: null, preds: [], start: '2026-11-02', finish: '2026-11-03', done: true },
      { id: 'a', name: 'Child', parent: 'parent', preds: [], start: '2026-11-02', finish: '2026-11-03', done: true },
      { id: 'sibling', name: 'Sibling', parent: 'parent', preds: [], start: '2026-11-02', finish: '2026-11-03', done: true },
      { id: 'b', name: 'Next', parent: null, preds: ['parent'], start: '2026-11-04', finish: '2026-11-05', done: false },
      { id: 'completed', name: 'Completed', parent: null, preds: ['parent'], start: '2026-11-04', finish: '2026-11-05', done: true },
    ]

    const preview = (await updateNode('a', { ...input, reason, preview: true }, 'pm')).preview!
    expect(preview.changes.map(change => [change.id, change.start, change.finish])).toEqual([
      ['parent', '2026-11-02', '2026-11-10'], ['a', '2026-11-02', '2026-11-10'], ['b', '2026-11-11', '2026-11-12'],
    ])
    expect(preview.skipped).toEqual(['Completed'])
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    expect(method('todo.createMany')).not.toHaveBeenCalled()
    expect(method('planChangeLog.create')).not.toHaveBeenCalled()

    method('planNode.update').mockClear()
    await updateNode('a', { ...input, reason, previewToken: preview.token }, 'pm')
    expect(method('planNode.update').mock.calls).toEqual([
      [{ where: { id: 'a' }, data: { planDate: input.planDate, phase: null } }],
      [{ where: { id: 'parent' }, data: { startDate: parseDay('2026-11-02'), planDate: parseDay('2026-11-10') } }],
      [{ where: { id: 'b' }, data: { startDate: parseDay('2026-11-11'), planDate: parseDay('2026-11-12') } }],
      [{ where: { id: 'b' }, data: { confirmStatus: 'PENDING', confirmedBy: null, confirmedAt: null, rejectReason: null } }],
      [{ where: { id: 'a' }, data: { confirmStatus: 'PENDING', confirmedBy: null, confirmedAt: null, rejectReason: null } }],
    ])
    expect(method('todo.createMany').mock.calls.flatMap(([arg]) => arg.data.map((todo: { refId: string }) => todo.refId))).toEqual(['b', 'a'])
    expect(method('planChangeLog.create').mock.calls.map(([arg]) => [arg.data.nodeId, arg.data.kind])).toEqual([
      ['parent', 'DATE'], ['b', 'DATE'], ['b', 'START'], ['a', 'DATE'],
    ])
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })
})

describe('linked date calendar snapshot', () => {
  it('loads shutdowns into the cascade and hashes a stable, serializable calendar', async () => {
    const actual = await vi.importActual<typeof import('../../server/services/plan/schedule-preview')>('../../server/services/plan/schedule-preview')
    vi.mocked(loadPlans).mockResolvedValue(new Map([['WO', {
      workOrderNumber: 'WO', status: 'DRAFT', publishedAt: null, deliveryDay: '2026-11-20', tasks: [],
      nodes: [row, { ...row, id: 'b', seq: 2, planDate: parseDay('2026-11-08'), startDate: parseDay('2026-11-06') }],
      forecast: forecastPlan([], '2026-11-20', '2026-11-01'),
    }]]))
    returns('planNodeDep.findMany', [{ nodeId: 'b', predId: 'a' }])
    returns('offDay.findMany', [{ date: parseDay('2026-11-08') }, { date: parseDay('2026-11-07') }])
    const before = await actual.scheduleSnapshot(prisma, 'WO')
    const after = before.nodes.map(node => ({ ...node, ...(node.id === 'a' ? { finish: '2026-11-06' } : {}) }))
    const preview = schedulePreview(before, after, 'a', input)
    expect(before.offDays).toEqual(new Set(['2026-11-07', '2026-11-08']))
    expect(before.version.offDays).toEqual(['2026-11-07', '2026-11-08'])
    expect(preview.changes[1]).toMatchObject({ start: '2026-11-09', finish: '2026-11-11' })
    expect(method('offDay.findMany')).toHaveBeenCalledWith({ select: { date: true }, orderBy: { date: 'asc' } })

    returns('offDay.findMany', [{ date: parseDay('2026-11-07') }, { date: parseDay('2026-11-08') }])
    const reordered = await actual.scheduleSnapshot(prisma, 'WO')
    expect(schedulePreview(reordered, after, 'a', input).token).toBe(preview.token)

    returns('offDay.findMany', [...before.version.offDays, '2026-12-25'].map(date => ({ date: parseDay(date) })))
    const changed = schedulePreview(await actual.scheduleSnapshot(prisma, 'WO'), after, 'a', input)
    expect(changed.changes).toEqual(preview.changes)
    expect(changed.token).not.toBe(preview.token)
  })
})
