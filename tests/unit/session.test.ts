import type { Session } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { SESSION_TTL_MS, createSession, destroySession, resolveSession } from '../../server/services/auth/session'
import { sha256Hex } from '../../server/services/auth/pkce'

/** 只实现会话服务用到的几个 Prisma 方法的内存替身 */
function memoryDb() {
  const rows = new Map<string, Session>()
  const session = {
    create: async ({ data }: { data: Omit<Session, 'createdAt'> }) => {
      const row = { createdAt: new Date(), ...data } as Session
      rows.set(row.id, row)
      return row
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
      const row = { ...rows.get(where.id)!, ...data }
      rows.set(where.id, row)
      return row
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id)
      rows.delete(where.id)
      return row
    },
    deleteMany: async ({ where }: { where: { id: string } }) => ({ count: rows.delete(where.id) ? 1 : 0 }),
  }
  return { rows, db: { session } as never }
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
