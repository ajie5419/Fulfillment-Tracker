import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'
import { logContext } from '../../server/observability/context'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
describe.skipIf(!DB)('transactional audit on disposable MySQL', () => {
  let db: PrismaClient
  let payments: typeof import('../../server/services/purchases/payments')
  let settings: typeof import('../../server/services/alerts/settings')
  let line: string
  const actor = { userId: 'audit-test-user', isAdmin: true }
  const requestId = '6a6fb6ad-652d-487d-85d1-96f1a676cf3b'
  const create = () => logContext.run({ requestId, actorId: actor.userId }, () => payments.createPayment({ purchaseLineIds: [line], amount: 49.5, requestDate: new Date('2026-11-12'), blocksDelivery: false, note: 'private description' }, actor.userId))

  beforeAll(async () => {
    process.env.DATABASE_URL = DB
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'pipe' })
    db = (await import('../../server/utils/prisma')).prisma
    payments = await import('../../server/services/purchases/payments')
    settings = await import('../../server/services/alerts/settings')
    const row = await db.purchaseLine.create({ data: { workOrderNumber: 'AUDIT-TEST', materialName: 'Fixture', quantity: 1, needDate: new Date() } })
    line = row.id
  })

  afterAll(async () => {
    if (!db) return
    await db.paymentRequest.deleteMany({ where: { workOrderNumber: 'AUDIT-TEST' } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: 'AUDIT-TEST' } })
    await db.auditLog.deleteMany({ where: { actorId: actor.userId } })
    await db.$disconnect()
  })

  it('commits linked snapshots, survives entity deletion, and preserves records across migration reapplication', async () => {
    const payment = await create()
    const entry = await db.auditLog.findFirstOrThrow({ where: { entityId: payment.id } })
    expect(entry).toMatchObject({ action: 'payment.create', actorId: actor.userId, requestId, metadata: { amount: 49.5, status: 'PENDING' } })
    expect(JSON.stringify(entry)).not.toContain('private description')
    await payments.deletePayment(payment.id, actor)
    expect(await db.paymentRequest.findUnique({ where: { id: payment.id } })).toBeNull()
    expect(await db.auditLog.count({ where: { entityId: payment.id } })).toBe(2)
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'pipe' })
    expect(await db.auditLog.count({ where: { entityId: payment.id } })).toBe(2)
    expect(await db.purchaseLine.findUnique({ where: { id: line } })).not.toBeNull()
  })

  it('rolls back real creates, status changes, deletions and settings when the audit database write fails', async () => {
    const payment = await create()
    await settings.saveThreshold('W1', { remindHours: 4, yellowDays: 1, redDays: 3 })
    const before = await db.auditLog.count()
    // This fixture owns its database. An unavailable audit table exercises a real database failure, not a mock.
    await db.$executeRawUnsafe('ALTER TABLE audit_log RENAME TO audit_test_unavailable')
    try {
      await expect(create()).rejects.toThrow()
      await expect(payments.setPaymentStatus(payment.id, 'PAID', null, actor)).rejects.toThrow()
      await expect(payments.deletePayment(payment.id, actor)).rejects.toThrow()
      await expect(settings.saveThreshold('W1', { remindHours: 4, yellowDays: 2, redDays: 4 })).rejects.toThrow()
      expect(await db.paymentRequest.count({ where: { workOrderNumber: 'AUDIT-TEST' } })).toBe(1)
      expect(await db.paymentRequest.findUnique({ where: { id: payment.id } })).toMatchObject({ status: 'PENDING' })
      expect(await db.threshold.findUnique({ where: { rule: 'W1' } })).toMatchObject({ yellowDays: 1, redDays: 3 })
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE audit_test_unavailable RENAME TO audit_log')
    }
    expect(await db.auditLog.count()).toBe(before)
  })
})
