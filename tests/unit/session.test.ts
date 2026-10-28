import type { QmsUser, Session } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_TTL_MS, createSession, destroySession, resolveSession } from '../../server/services/auth/session'
import { sha256Hex } from '../../server/services/auth/pkce'
import { RESOURCES } from '../../server/services/sync/resources'

/** 只实现会话服务用到的几个 Prisma 方法的内存替身 */
function memoryDb() {
  const rows = new Map<string, Session>()
  const accounts = new Map<string, Pick<QmsUser, 'id' | 'status' | 'isDeleted'>>([
    ['u1', { id: 'u1', status: 'ACTIVE', isDeleted: false }],
    ['other', { id: 'other', status: 'ACTIVE', isDeleted: false }],
  ])
  const hooks = { beforeRenew: () => {} }
  type Where = { id?: string; qmsUserId?: string; expiresAt?: { gt?: Date; lte?: Date } }
  const matches = (row: Session, where: Where) =>
    (!where.id || row.id === where.id) && (!where.qmsUserId || row.qmsUserId === where.qmsUserId) &&
    (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt) && (!where.expiresAt?.lte || row.expiresAt <= where.expiresAt.lte)
  const session = {
    create: async ({ data }: { data: Omit<Session, 'createdAt'> }) => {
      const row = { createdAt: new Date(), ...data } as Session
      rows.set(row.id, row)
      return row
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Session> }) => {
      hooks.beforeRenew()
      let count = 0
      for (const [id, row] of rows) if (matches(row, where)) { rows.set(id, { ...row, ...data }); count++ }
      return { count }
    }),
    deleteMany: async ({ where }: { where: Where }) => {
      let count = 0
      for (const [id, row] of rows) if (matches(row, where)) { rows.delete(id); count++ }
      return { count }
    },
  }
  const qmsUser = {
    findUnique: async ({ where }: { where: { id: string } }) => accounts.get(where.id) ?? null,
    upsert: async ({ where, create, update }: { where: { id: string }; create: QmsUser; update: Partial<QmsUser> }) => {
      const row = accounts.has(where.id) ? { ...accounts.get(where.id)!, ...update } : create
      accounts.set(where.id, row)
      return row
    },
  }
  const db = { session, qmsUser, $queryRaw: async () => [], $transaction: async (fn: (tx: unknown) => unknown) => fn(db) }
  return { rows, accounts, hooks, session, db: db as never }
}

const user = { qmsUserId: 'u1', userName: '张三' }

describe('会话', () => {
  it('库里只存令牌哈希，有效期 30 天', async () => {
    const { rows, db } = memoryDb()
    const now = new Date('2026-10-16T00:00:00Z')
    const { token, expiresAt } = await createSession(db, user, now)
    expect(rows.has(token)).toBe(false)
    expect(rows.has(sha256Hex(token))).toBe(true)
    expect(expiresAt.getTime() - now.getTime()).toBe(SESSION_TTL_MS)
  })

  it('有效期内可解析，前半段不续期', async () => {
    const { db } = memoryDb()
    const t0 = new Date('2026-10-16T00:00:00Z')
    const { token } = await createSession(db, user, t0)
    const r = await resolveSession(db, token, new Date(t0.getTime() + 24 * 3600_000))
    expect(r?.session.qmsUserId).toBe('u1')
    expect(r?.renewedExpiresAt).toBeNull()
  })

  it('过半后访问自动续满 30 天（A1：关掉微信再打开不用重新登录）', async () => {
    const { db } = memoryDb()
    const t0 = new Date('2026-10-16T00:00:00Z')
    const { token } = await createSession(db, user, t0)
    const t20 = new Date(t0.getTime() + 20 * 24 * 3600_000)
    const r = await resolveSession(db, token, t20)
    expect(r?.renewedExpiresAt?.getTime()).toBe(t20.getTime() + SESSION_TTL_MS)
  })

  it('过期会话失效并被删除', async () => {
    const { rows, db } = memoryDb()
    const t0 = new Date('2026-10-16T00:00:00Z')
    const { token } = await createSession(db, user, t0)
    expect(await resolveSession(db, token, new Date(t0.getTime() + SESSION_TTL_MS + 1))).toBeNull()
    expect(rows.size).toBe(0)
  })

  it('未知、空、超长令牌都返回 null；退出后令牌失效', async () => {
    const { db } = memoryDb()
    const { token } = await createSession(db, user)
    expect(await resolveSession(db, undefined)).toBeNull()
    expect(await resolveSession(db, 'nope')).toBeNull()
    expect(await resolveSession(db, 'x'.repeat(200))).toBeNull()
    await destroySession(db, token)
    expect(await resolveSession(db, token)).toBeNull()
  })
})

const unavailable = ['INACTIVE', 'DISABLED', 'deleted', 'missing'] as const
function invalidate(accounts: ReturnType<typeof memoryDb>['accounts'], state: typeof unavailable[number]) {
  if (state === 'missing') accounts.delete('u1')
  else accounts.set('u1', { id: 'u1', status: state === 'deleted' ? 'ACTIVE' : state, isDeleted: state === 'deleted' })
}

describe('account revocation', () => {
  it.each(unavailable)('refuses new sessions for a %s account', async (state) => {
    const { accounts, rows, db } = memoryDb()
    invalidate(accounts, state)
    await expect(createSession(db, user)).rejects.toThrow(state === 'missing' ? '尚未同步' : '已停用')
    expect(rows.size).toBe(0)
  })

  it.each(unavailable.flatMap((state) => [1, 20].map((days) => ({ state, days }))))('rejects $state accounts on day $days, including renewal requests', async ({ state, days }) => {
    const { accounts, rows, session, db } = memoryDb()
    const now = new Date('2026-10-16T00:00:00Z')
    const { token } = await createSession(db, user, now)
    invalidate(accounts, state)
    expect(await resolveSession(db, token, new Date(+now + days * 86400_000))).toBeNull()
    expect(rows.size).toBe(0)
    expect(session.updateMany).not.toHaveBeenCalled()
  })

  it('revokes every device for the invalid account while preserving other accounts', async () => {
    const { accounts, rows, db } = memoryDb()
    const first = await createSession(db, user)
    const second = await createSession(db, user)
    const other = await createSession(db, { qmsUserId: 'other', userName: 'Other' })
    invalidate(accounts, 'INACTIVE')
    expect(await resolveSession(db, first.token)).toBeNull()
    accounts.set('u1', { id: 'u1', status: 'ACTIVE', isDeleted: false })
    expect(await resolveSession(db, second.token)).toBeNull()
    expect(await resolveSession(db, other.token)).not.toBeNull()
    expect(rows.size).toBe(1)
  })

  it.each([{ isActive: false, isDeleted: false }, { isActive: true, isDeleted: true }])('sync revokes all devices before account recovery, even without a request: %o', async (state) => {
    const { db, rows } = memoryDb()
    const first = await createSession(db, user)
    const second = await createSession(db, user)
    const other = await createSession(db, { qmsUserId: 'other', userName: 'Other' })
    const synced = (flags: typeof state) => RESOURCES.users.schema.parse({ id: 'u1', username: 'user', updatedAt: '2026-10-28T00:00:00Z', ...flags })
    await RESOURCES.users.write(db, [synced(state)])
    expect(rows.size).toBe(1)
    await RESOURCES.users.write(db, [synced({ isActive: true, isDeleted: false })])
    expect(await resolveSession(db, first.token)).toBeNull()
    expect(await resolveSession(db, second.token)).toBeNull()
    expect(await resolveSession(db, other.token)).not.toBeNull()
    expect(await createSession(db, user)).toHaveProperty('token')
  })

  it('active user sync preserves existing sessions', async () => {
    const { db } = memoryDb()
    const { token } = await createSession(db, user)
    const row = RESOURCES.users.schema.parse({ id: 'u1', username: 'user', isActive: true, updatedAt: '2026-10-28T00:00:00Z' })
    await RESOURCES.users.write(db, [row])
    expect(await resolveSession(db, token)).not.toBeNull()
  })

  it('returns unauthenticated when revocation wins the renewal race', async () => {
    const { db, rows, hooks } = memoryDb()
    const now = new Date('2026-10-16T00:00:00Z')
    const { token } = await createSession(db, user, now)
    hooks.beforeRenew = () => rows.delete(sha256Hex(token))
    expect(await resolveSession(db, token, new Date(+now + 20 * 86400_000))).toBeNull()
    expect(rows.size).toBe(0)
  })
})
