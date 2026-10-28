import type { Todo } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowForbidden } from '../../server/services/flow/errors'

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  todo: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  qmsUser: { findFirst: vi.fn() },
  notifyRole: { findFirst: vi.fn() },
  workOrderExt: { findMany: vi.fn() },
  routeStep: { findUnique: vi.fn() },
  part: { findUnique: vi.fn() },
  release: { findUnique: vi.fn() },
  planNode: { findUnique: vi.fn() },
  planTask: { findUnique: vi.fn(), updateMany: vi.fn() },
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))

import { transferTodo } from '../../server/services/flow/todos'

const owner = { userId: 'owner', isAdmin: false }
const references = [
  ['step', 'ARRANGE_START'],
  ['part', 'READY_TO_START'],
  ['release', 'CONFIRM_CHANGE'],
  ['planNode', 'CONFIRM_PLAN_NODE'],
  ['planTask', 'DO_PLAN_TASK'],
] as const
let todo: Todo
let recipient: { id: string; status: string; isDeleted: boolean } | null
let managed: Record<string, string[]>

function noWrites() {
  expect(db.todo.update).not.toHaveBeenCalled()
  expect(db.todo.create).not.toHaveBeenCalled()
  expect(db.planTask.updateMany).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  todo = { id: 'todo', ownerId: 'owner', action: 'ARRANGE_START', refType: 'step', refId: 'object', status: 'OPEN', dueAt: new Date('2026-11-01'), doneAt: null, createdAt: new Date() }
  recipient = { id: 'recipient', status: 'ACTIVE', isDeleted: false }
  managed = {}
  db.$transaction.mockImplementation((fn) => fn(db))
  db.todo.findUnique.mockImplementation(async () => todo)
  db.todo.update.mockImplementation(async ({ data }) => Object.assign(todo, data))
  db.todo.create.mockImplementation(async ({ data }) => ({ id: 'new-todo', status: 'OPEN', ...data }))
  db.qmsUser.findFirst.mockImplementation(async ({ where }) => {
    if (!recipient || recipient.id !== where.id || recipient.isDeleted !== where.isDeleted) return null
    if (where.status && recipient.status !== where.status) return null
    return { id: recipient.id }
  })
  db.notifyRole.findFirst.mockResolvedValue(null)
  db.workOrderExt.findMany.mockImplementation(async ({ where }) => (managed[where.projectManagerId] ?? []).map((workOrderNumber) => ({ workOrderNumber })))
  db.routeStep.findUnique.mockResolvedValue({ part: { workOrderNumber: 'WO' } })
  for (const table of [db.part, db.release, db.planNode, db.planTask]) table.findUnique.mockResolvedValue({ workOrderNumber: 'WO' })
})

describe('todo transfer authorization', () => {
  it.each(references)('allows the owner to delegate %s within the recipient scope', async (refType, action) => {
    Object.assign(todo, { refType, action })
    const moved = await transferTodo(todo.id, 'recipient', owner)
    expect(moved).toMatchObject({ ownerId: 'recipient', refType, refId: 'object', action, dueAt: todo.dueAt, status: 'OPEN' })
    expect(todo.status).toBe('TRANSFERRED')
    if (refType === 'planTask') expect(db.planTask.updateMany).toHaveBeenCalledWith({ where: { id: 'object' }, data: { ownerId: 'recipient' } })
  })

  it.each(references)('rejects another user taking a %s todo, without creating delegated access', async (refType, action) => {
    Object.assign(todo, { refType, action })
    await expect(transferTodo(todo.id, 'recipient', { userId: 'recipient', isAdmin: false })).rejects.toBeInstanceOf(FlowForbidden)
    noWrites()
  })

  it('does not grant administrators an ownership bypass', async () => {
    await expect(transferTodo(todo.id, 'recipient', { userId: 'admin', isAdmin: true })).rejects.toBeInstanceOf(FlowForbidden)
    noWrites()
  })

  it.each(['INACTIVE', 'DISABLED'])('rejects a %s recipient', async (status) => {
    recipient!.status = status
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toThrow('转交对象不存在或已停用')
    noWrites()
  })

  it.each(['deleted', 'missing'])('rejects a %s recipient', async (state) => {
    if (state === 'deleted') recipient!.isDeleted = true
    else recipient = null
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toThrow('转交对象不存在或已停用')
    noWrites()
  })

  it.each(references)('rejects a %s recipient restricted to another work order', async (refType, action) => {
    Object.assign(todo, { refType, action })
    managed.recipient = ['OTHER']
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toBeInstanceOf(FlowForbidden)
    noWrites()
  })

  it('allows a recipient managing this work order', async () => {
    managed.recipient = ['WO']
    await expect(transferTodo(todo.id, 'recipient', owner)).resolves.toMatchObject({ ownerId: 'recipient' })
  })

  it('honors an independently configured recipient administrator scope', async () => {
    managed.recipient = ['OTHER']
    await expect(transferTodo(todo.id, 'recipient', owner, true)).resolves.toMatchObject({ ownerId: 'recipient' })
  })

  it('honors the owner administrator scope without bypassing ownership', async () => {
    managed.owner = ['OTHER']
    await expect(transferTodo(todo.id, 'recipient', { ...owner, isAdmin: true })).resolves.toMatchObject({ ownerId: 'recipient' })
  })

  it('uses notification roles when resolving the recipient scope', async () => {
    managed.recipient = ['OTHER']
    db.notifyRole.findFirst.mockImplementation(async ({ where }) => where.userId === 'recipient' ? { id: 'role' } : null)
    await expect(transferTodo(todo.id, 'recipient', owner)).resolves.toMatchObject({ ownerId: 'recipient' })
  })

  it.each(['step', 'part'])('rejects a %s owner who has lost work-order visibility', async (refType) => {
    todo.refType = refType
    managed.owner = ['OTHER']
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toBeInstanceOf(FlowForbidden)
    noWrites()
  })

  it.each(references.slice(2))('preserves the assigned %s owner visibility exception', async (refType, action) => {
    Object.assign(todo, { refType, action })
    managed.owner = ['OTHER']
    await expect(transferTodo(todo.id, 'recipient', owner)).resolves.toMatchObject({ ownerId: 'recipient' })
  })

  it('rejects a signature todo even for its owner', async () => {
    Object.assign(todo, { refType: 'receipt', action: 'SIGN_RELEASE' })
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toThrow('签收待办不能转交')
    noWrites()
  })

  it('rejects unsupported references and deleted business objects', async () => {
    todo.refType = 'unknown'
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toThrow('不支持转交')
    todo.refType = 'step'
    db.routeStep.findUnique.mockResolvedValue(null)
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toThrow('关联对象不存在')
    noWrites()
  })

  it('rejects repeat transfers and transfers to the current owner', async () => {
    await expect(transferTodo(todo.id, owner.userId, owner)).rejects.toThrow('不能转交给当前负责人')
    noWrites()
    await transferTodo(todo.id, 'recipient', owner)
    await expect(transferTodo(todo.id, 'recipient', owner)).rejects.toThrow('已处理或已转交')
    expect(db.todo.create).toHaveBeenCalledTimes(1)
  })
})
