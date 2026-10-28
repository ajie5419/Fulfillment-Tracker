import type { JobLock, SyncCursor } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  jobLock: { createMany: vi.fn(), updateMany: vi.fn() },
  syncCursor: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  qmsDepartment: { upsert: vi.fn() },
  reminder: { createMany: vi.fn() },
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))

import { acquireLease, LeaseLostError, releaseLease, withLease, type LeaseGuard } from '../../server/services/jobs/lease'
import { runSyncJob } from '../../server/services/sync/job'
import { alertAdminsIfNeeded, syncQms, syncResource } from '../../server/services/sync/sync'
import { matchInspection, matchPendingInspections } from '../../server/services/flow/match'
import { matchIncoming, matchIncomingInspections } from '../../server/services/purchases/incoming'
import { syncNonconforming } from '../../server/services/issues/nonconforming'

const LEASE_MS = 15 * 60_000
const config = { apiBase: 'http://qms.test', clientId: 'test', clientSecret: 'test-only', enabled: true }
let locks: Map<string, JobLock>
let cursors: Map<string, SyncCursor>
let departments: Map<string, { id: string; name: string; updatedAt: Date }>
const response = (name: string, updatedAt = '2026-10-28T01:00:00.000Z') => new Response(JSON.stringify({
  code: 0, data: { items: [{ id: 'dept', name, updatedAt }], nextCursor: null },
}), { headers: { 'Content-Type': 'application/json' } })
const run = (fetchImpl: typeof fetch) => runSyncJob({ config, adminIds: [], only: ['departments'], fetchImpl })

/** Stateful storage exercises the real lease and sync services, not MySQL locking. */
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-28T02:00:00Z'))
  locks = new Map()
  cursors = new Map()
  departments = new Map()
  db.jobLock.createMany.mockImplementation(async ({ data }) => {
    for (const row of data) if (!locks.has(row.name)) locks.set(row.name, { holder: null, ...row })
    return { count: 1 }
  })
  db.jobLock.updateMany.mockImplementation(async ({ where, data }) => {
    const row = locks.get(where.name)
    if (!row || (where.holder !== undefined && row.holder !== where.holder)) return { count: 0 }
    if (where.lockedUntil?.lt && !(row.lockedUntil < where.lockedUntil.lt)) return { count: 0 }
    if (where.lockedUntil?.gt && !(row.lockedUntil > where.lockedUntil.gt)) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  })
  db.syncCursor.upsert.mockImplementation(async ({ where, create, update }) => {
    const row = cursors.get(where.resource) ?? {
      since: null, afterId: null, lastRunAt: null, lastSyncedAt: null, lastError: null, failCount: 0, alertedAt: null, ...create,
    }
    if (cursors.has(where.resource)) Object.assign(row, update)
    cursors.set(where.resource, row)
    return structuredClone(row)
  })
  db.syncCursor.update.mockImplementation(async ({ where, data }) => {
    const row = cursors.get(where.resource)!
    const { failCount, ...rest } = data
    Object.assign(row, rest)
    if (failCount !== undefined) row.failCount = typeof failCount === 'number' ? failCount : row.failCount + failCount.increment
    return structuredClone(row)
  })
  db.syncCursor.findMany.mockImplementation(async () => structuredClone([...cursors.values()]))
  db.syncCursor.updateMany.mockResolvedValue({ count: 1 })
  db.qmsDepartment.upsert.mockImplementation(async ({ create }) => departments.set(create.id, create))
  db.reminder.createMany.mockResolvedValue({ count: 1 })
  db.$queryRaw.mockImplementation(async (sql, name) => String(sql[0]).includes('FROM job_lock') ? structuredClone(locks.has(name) ? [locks.get(name)] : []) : [])
  db.$transaction.mockImplementation(async (fn) => {
    const before = structuredClone({ locks, cursors, departments })
    try {
      return await fn(db)
    } catch (err) {
      ;({ locks, cursors, departments } = before)
      throw err
    }
  })
})

afterEach(() => vi.useRealTimers())

describe('sync lease ownership', () => {
  it('skips a competing run without fetching or releasing the current owner', async () => {
    await acquireLease('sync-qms', 'owner', LEASE_MS)
    const fetchImpl = vi.fn()
    expect(await run(fetchImpl)).toEqual({ skipped: 'running' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(locks.get('sync-qms')?.holder).toBe('owner')
  })

  it('rejects an expired worker after a replacement commits a newer page', async () => {
    const old = await run(async () => {
      vi.setSystemTime(Date.now() + LEASE_MS + 1)
      expect((await run(async () => response('new', '2026-10-28T01:30:00.000Z'))).sync?.resources[0]?.status).toBe('ok')
      return response('old')
    }).catch((err) => err)
    expect(departments.get('dept')?.name).toBe('new')
    expect(cursors.get('departments')?.since).toEqual(new Date('2026-10-28T01:30:00.000Z'))
    expect(cursors.get('departments')?.failCount).toBe(0)
    expect(old).toBeInstanceOf(Error)
    expect(old).toBeInstanceOf(LeaseLostError)
  })

  it('does not revive an expired lease even if nobody has taken it over', async () => {
    const result = await run(async () => {
      vi.setSystemTime(Date.now() + LEASE_MS + 1)
      return response('expired')
    }).catch((err) => err)
    expect(departments.size).toBe(0)
    expect(cursors.get('departments')?.since).toBeNull()
    expect(result).toBeInstanceOf(Error)
    expect(result).toBeInstanceOf(LeaseLostError)
  })

  it('rejects a lease at the exact expiry boundary', async () => {
    await expect(run(async () => {
      vi.setSystemTime(Date.now() + LEASE_MS)
      return response('expired')
    })).rejects.toBeInstanceOf(LeaseLostError)
    expect(departments.size).toBe(0)
  })

  it('keeps a healthy long-running worker exclusive by renewing between pages', async () => {
    let calls = 0
    await run(async () => {
      calls++
      vi.setSystemTime(Date.now() + LEASE_MS / 2)
      expect(await acquireLease('sync-qms', 'competitor', LEASE_MS)).toBe(false)
      if (calls === 3) return response('last')
      const since = `2026-10-28T01:0${calls}:00.000Z`
      return new Response(JSON.stringify({ code: 0, data: {
        items: [{ id: 'dept', name: `page-${calls}`, updatedAt: since }], nextCursor: { since, afterId: 'dept' },
      } }))
    })
    expect(calls).toBe(3)
    expect(departments.get('dept')?.name).toBe('last')
  })

  it('does not let a stale release clear the new owner', async () => {
    await acquireLease('sync-qms', 'old', LEASE_MS)
    vi.setSystemTime(Date.now() + LEASE_MS + 1)
    expect(await acquireLease('sync-qms', 'new', LEASE_MS)).toBe(true)
    await releaseLease('sync-qms', 'old')
    expect(locks.get('sync-qms')?.holder).toBe('new')
  })

  it('checks expiry after waiting for the lease-row lock', async () => {
    await expect(withLease('sync-qms', LEASE_MS, async (lease) => {
      const query = db.$queryRaw.getMockImplementation()!
      db.$queryRaw.mockImplementationOnce(async (...args) => {
        const row = await query(...args)
        vi.setSystemTime(Date.now() + LEASE_MS + 1)
        return row
      })
      await db.$transaction(lease)
    })).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('rejects writes when the lease row has been removed', async () => {
    await expect(withLease('sync-qms', LEASE_MS, async (lease) => {
      locks.delete('sync-qms')
      await db.$transaction(lease)
    })).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('rolls back a copied page and cursor together on a database error', async () => {
    db.syncCursor.update.mockRejectedValueOnce(new Error('page write failed'))
    const result = await run(async () => response('rolled back'))
    expect(result.sync?.resources[0]).toMatchObject({ status: 'failed', rows: 0, error: expect.stringContaining('page write failed') })
    expect(departments.size).toBe(0)
    expect(cursors.get('departments')).toMatchObject({ since: null, failCount: 1 })
  })

  it('retains ordinary per-resource failure handling while the lease is valid', async () => {
    const result = await run(async () => { throw new Error('offline') })
    expect(result.sync?.resources[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('offline') })
    expect(cursors.get('departments')).toMatchObject({ failCount: 1, since: null })
    expect(locks.get('sync-qms')?.holder).toBeNull()
  })

  it('does not overwrite the replacement owner failure metadata after a late fetch error', async () => {
    await expect(run(async () => {
      vi.setSystemTime(Date.now() + LEASE_MS + 1)
      await run(async () => response('new'))
      throw new Error('old fetch failed')
    })).rejects.toBeInstanceOf(LeaseLostError)
    expect(cursors.get('departments')).toMatchObject({ failCount: 0, lastError: null })
  })

  it('does not clear new failure metadata from a stale success cleanup', async () => {
    await expect(withLease('sync-qms', LEASE_MS, async (lease) => {
      const transaction = db.$transaction.getMockImplementation()!
      let replaced = false
      db.$transaction.mockImplementation(async (fn) => {
        const result = await transaction(fn)
        if (cursors.get('departments')?.since && !replaced) {
          replaced = true
          locks.get('sync-qms')!.holder = 'replacement'
          cursors.get('departments')!.lastError = 'new owner failure'
        }
        return result
      })
      await syncResource('departments', { config, adminIds: [], lease, fetchImpl: async () => response('one') })
    })).rejects.toBeInstanceOf(LeaseLostError)
    expect(cursors.get('departments')?.lastError).toBe('new owner failure')
  })
})

describe('lease propagation', () => {
  const lost: LeaseGuard = async () => { throw new LeaseLostError('sync-qms') }

  it('checks ownership before initializing or marking a resource as running', async () => {
    const fetchImpl = vi.fn()
    await expect(syncResource('departments', { config, adminIds: [], lease: lost, fetchImpl })).rejects.toBeInstanceOf(LeaseLostError)
    expect(cursors.size).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops the resource loop on lease loss rather than continuing or alerting', async () => {
    await expect(syncQms({ config, adminIds: ['admin'], lease: lost })).rejects.toBeInstanceOf(LeaseLostError)
    expect(db.syncCursor.findMany).not.toHaveBeenCalled()
    expect(db.reminder.createMany).not.toHaveBeenCalled()
  })

  it('fences administrator reminders and alertedAt updates', async () => {
    cursors.set('departments', {
      resource: 'departments', since: null, afterId: null, lastRunAt: null, lastSyncedAt: null, lastError: 'offline', failCount: 3, alertedAt: null,
    })
    await expect(alertAdminsIfNeeded(['admin'], new Date(), lost)).rejects.toBeInstanceOf(LeaseLostError)
    expect(db.reminder.createMany).not.toHaveBeenCalled()
    expect(db.syncCursor.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['return matching', (lease: LeaseGuard) => matchInspection('inspection', lease)],
    ['incoming matching', (lease: LeaseGuard) => matchIncoming('inspection', lease)],
    ['return batch', (lease: LeaseGuard) => matchPendingInspections(lease)],
    ['incoming batch', (lease: LeaseGuard) => matchIncomingInspections(lease)],
    ['nonconforming batch', (lease: LeaseGuard) => syncNonconforming(lease)],
  ] as const)('checks the fence before %s business reads or writes', async (_name, fn) => {
    db.$queryRaw.mockResolvedValue([{ id: 'inspection', stepId: 'step' }])
    await expect(fn(lost)).rejects.toBeInstanceOf(LeaseLostError)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2, 3])('aborts the job when ownership is lost in post-sync phase %i', async (phase) => {
    let queries = 0
    db.$queryRaw.mockImplementation(async (sql, name) => {
      if (String(sql[0]).includes('FROM job_lock')) return structuredClone([locks.get(name)])
      if (++queries !== phase) return []
      locks.get('sync-qms')!.holder = 'replacement'
      return [{ id: 'inspection', stepId: 'step' }]
    })
    await expect(runSyncJob({ config, adminIds: [], only: ['inspections'], fetchImpl: async () => new Response(JSON.stringify({
      code: 0, data: { items: [], nextCursor: null },
    })) })).rejects.toBeInstanceOf(LeaseLostError)
    expect(queries).toBe(phase)
    expect(locks.get('sync-qms')?.holder).toBe('replacement')
  })

  it('continues subsequent post-sync phases after an ordinary business failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let queries = 0
    try {
      db.$queryRaw.mockImplementation(async (sql, name) => {
        if (String(sql[0]).includes('FROM job_lock')) return structuredClone([locks.get(name)])
        if (++queries === 1) throw new Error('matching failed')
        return []
      })
      const result = await runSyncJob({ config, adminIds: [], only: ['inspections'], fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { items: [], nextCursor: null } })) })
      expect(result).toMatchObject({ match: { error: 'matching failed' }, incoming: { arrived: 0, other: 0 }, nonconforming: { created: 0, existed: 0 } })
      expect(queries).toBe(3)
    } finally {
      log.mockRestore()
    }
  })

  it('does not acquire a lease or fetch when synchronization is disabled', async () => {
    expect(await runSyncJob({ config: { ...config, enabled: false }, adminIds: [] })).toEqual({ skipped: 'not-configured' })
    expect(db.jobLock.createMany).not.toHaveBeenCalled()
  })
})
