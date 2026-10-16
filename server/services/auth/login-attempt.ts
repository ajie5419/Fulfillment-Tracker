/**
 * 登录过程的 state / code_verifier 存在服务端，消费即删除：
 * 同一个回调重放、或拿旧 Cookie 重放，都不会第二次成功。
 */
import type { PrismaClient } from '@prisma/client'
import { codeChallengeS256, createCodeVerifier, randomToken, sha256Hex } from './pkce'

export const LOGIN_STATE_COOKIE = 'ft_login_state'
export const LOGIN_TTL_MS = 10 * 60 * 1000

type Db = Pick<PrismaClient, 'loginAttempt'>

export async function startLogin(db: Db, redirect: string, now = new Date()) {
  const state = randomToken(24)
  const codeVerifier = createCodeVerifier()
  await db.loginAttempt.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.loginAttempt.create({
    data: { id: sha256Hex(state), codeVerifier, redirect, expiresAt: new Date(now.getTime() + LOGIN_TTL_MS) },
  })
  return { state, codeChallenge: codeChallengeS256(codeVerifier) }
}

/** 返回 null 表示 state 不存在、已过期或已被消费。 */
export async function consumeLogin(db: Db, state: string, now = new Date()) {
  if (!state || state.length > 128) return null
  const id = sha256Hex(state)
  const row = await db.loginAttempt.findUnique({ where: { id } })
  if (!row) return null
  // 以删除成功作为"抢到"这次登录的依据，并发重放时只有一个请求能拿到 count=1
  const { count } = await db.loginAttempt.deleteMany({ where: { id } })
  if (count !== 1 || row.expiresAt.getTime() <= now.getTime()) return null
  return { codeVerifier: row.codeVerifier, redirect: row.redirect }
}
