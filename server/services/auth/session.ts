/**
 * 履约自己的登录会话：30 天，httpOnly Cookie 存随机令牌，库里只存令牌的 SHA-256。
 * 剩余不足一半有效期时自动续期，手机端常用就一直不用重新登录（验收 A1）。
 */
import type { PrismaClient, Session } from '@prisma/client'
import { randomToken, sha256Hex } from './pkce'

export const SESSION_COOKIE = 'ft_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

type Db = Pick<PrismaClient, 'session' | 'qmsUser'>

/** Distinguish an unsynchronized account from a synchronized account that cannot sign in. */
export class SessionAccountUnavailable extends Error {
  constructor(readonly unsynced: boolean) {
    super(unsynced ? '账号资料尚未同步，请等待 QMS 用户同步成功后重新登录' : '该 QMS 账号不可用或已停用')
    this.name = 'SessionAccountUnavailable'
  }
}

export interface SessionUser {
  qmsUserId: string
  userName: string
}

export async function createSession(db: Db & Pick<PrismaClient, '$transaction'>, user: SessionUser, now = new Date()) {
  const token = randomToken()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  await db.$transaction(async (tx) => {
    // Serialize with user sync so a login cannot insert a session after sync has revoked that account.
    await tx.$queryRaw`SELECT id FROM qms_user WHERE id = ${user.qmsUserId} FOR SHARE`
    const account = await tx.qmsUser.findUnique({ where: { id: user.qmsUserId }, select: { status: true, isDeleted: true } })
    if (!account || account.status !== 'ACTIVE' || account.isDeleted) throw new SessionAccountUnavailable(!account)
    await tx.session.create({
      data: { id: sha256Hex(token), qmsUserId: user.qmsUserId, userName: user.userName, expiresAt, lastSeenAt: now },
    })
  })
  return { token, expiresAt }
}

/** 返回有效会话；过期的顺手删除。renewedExpiresAt 非空表示调用方需要重设 Cookie。 */
export async function resolveSession(
  db: Db,
  token: string | undefined,
  now = new Date(),
): Promise<{ session: Session; renewedExpiresAt: Date | null } | null> {
  if (!token || token.length > 128) return null
  const id = sha256Hex(token)
  const session = await db.session.findUnique({ where: { id } })
  if (!session) return null
  if (session.expiresAt.getTime() <= now.getTime()) {
    await db.session.deleteMany({ where: { id, expiresAt: { lte: now } } })
    return null
  }
  const account = await db.qmsUser.findUnique({ where: { id: session.qmsUserId }, select: { status: true, isDeleted: true } })
  if (!account || account.status !== 'ACTIVE' || account.isDeleted) {
    await db.session.deleteMany({ where: { qmsUserId: session.qmsUserId } })
    return null
  }
  const remaining = session.expiresAt.getTime() - now.getTime()
  if (remaining < SESSION_TTL_MS / 2) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
    // Revocation or logout may delete the session after the read; never recreate it or turn that race into a 500.
    const renewed = await db.session.updateMany({ where: { id, expiresAt: { gt: now } }, data: { expiresAt, lastSeenAt: now } })
    if (!renewed.count) return null
    return { session: { ...session, expiresAt, lastSeenAt: now }, renewedExpiresAt: expiresAt }
  }
  return { session, renewedExpiresAt: null }
}

export async function destroySession(db: Db, token: string | undefined) {
  if (!token) return
  await db.session.deleteMany({ where: { id: sha256Hex(token) } })
}
