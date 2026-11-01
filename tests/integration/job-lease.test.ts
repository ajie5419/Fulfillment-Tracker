import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)

describe.skipIf(!DB)('job lease fencing in MySQL', () => {
  let db: PrismaClient
  let leases: typeof import('../../server/services/jobs/lease')
  const names = new Set<string>()
  const uniqueName = () => {
    const name = `lease-test-${randomUUID().slice(0, 20)}`
    names.add(name)
    return name
  }

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    leases = await import('../../server/services/jobs/lease')
  })

  afterEach(async () => {
    const ids = [...names]
    await db.qmsDepartment.deleteMany({ where: { id: { in: ids } } })
    await db.syncCursor.deleteMany({ where: { resource: { in: ids } } })
    await db.jobLock.deleteMany({ where: { name: { in: ids } } })
    names.clear()
  })
  afterAll(async () => { await db?.$disconnect() })

  it('prevents a stale worker from changing copied rows or advancing its cursor after takeover', async () => {
    const name = uniqueName()
    const newer = new Date('2026-10-28T02:00:00Z')
    await expect(leases.withLease(name, 60_000, async (oldGuard) => {
      await db.jobLock.update({ where: { name }, data: { lockedUntil: new Date(0) } })
      expect((await leases.withLease(name, 60_000, async (newGuard) => db.$transaction(async (tx) => {
        await newGuard(tx)
        await tx.qmsDepartment.create({ data: { id: name, name: 'new', parentId: '0', status: 1, updatedAt: newer } })
        await tx.syncCursor.create({ data: { resource: name, since: newer, afterId: 'new' } })
      }))).skipped).toBe(false)
      await db.$transaction(async (tx) => {
        await oldGuard(tx)
        await tx.qmsDepartment.update({ where: { id: name }, data: { name: 'old' } })
        await tx.syncCursor.update({ where: { resource: name }, data: { since: new Date(0), afterId: 'old' } })
      })
    })).rejects.toBeInstanceOf(leases.LeaseLostError)
    expect((await db.qmsDepartment.findUniqueOrThrow({ where: { id: name } })).name).toBe('new')
    expect(await db.syncCursor.findUniqueOrThrow({ where: { resource: name } })).toMatchObject({ since: newer, afterId: 'new', failCount: 0 })
  })

  it('renews a valid lease and rolls renewal back with the business transaction', async () => {
    const name = uniqueName()
    await leases.withLease(name, 60_000, async (guard) => {
      const shortExpiry = new Date(Date.now() + 30_000)
      await db.jobLock.update({ where: { name }, data: { lockedUntil: shortExpiry } })
      await expect(db.$transaction(async (tx) => {
        await guard(tx)
        const row = await tx.jobLock.findUniqueOrThrow({ where: { name } })
        expect(row.lockedUntil.getTime()).toBeGreaterThan(shortExpiry.getTime())
        throw new Error('rollback')
      })).rejects.toThrow('rollback')
      expect((await db.jobLock.findUniqueOrThrow({ where: { name } })).lockedUntil).toEqual(shortExpiry)
    })
  })

  it('holds the lease row until the protected write commits, even if its timestamp expires', async () => {
    const name = uniqueName()
    let takeover: Promise<boolean> | undefined
    try {
      await leases.withLease(name, 60_000, async (guard) => {
        await db.$transaction(async (tx) => {
          await guard(tx)
          // Force expiry while the row lock is held instead of sleeping through a real lease interval.
          await tx.jobLock.update({ where: { name }, data: { lockedUntil: new Date(0) } })
          takeover = leases.acquireLease(name, 'replacement', 60_000)
          const state = await Promise.race([takeover.then(() => 'acquired'), new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100))])
          expect(state).toBe('blocked')
          await tx.qmsDepartment.create({ data: { id: name, name: 'committed', parentId: '0', status: 1, updatedAt: new Date() } })
        })
        expect(await takeover).toBe(true)
      })
      expect((await db.jobLock.findUniqueOrThrow({ where: { name } })).holder).toBe('replacement')
      expect((await db.qmsDepartment.findUniqueOrThrow({ where: { id: name } })).name).toBe('committed')
    } finally {
      await takeover
    }
  })
})
