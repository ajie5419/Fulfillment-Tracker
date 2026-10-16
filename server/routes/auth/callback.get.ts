import { timingSafeEqual } from 'node:crypto'
import { IdentityBridgeError, exchangeCode, revokeCredential, verifyIdentity } from '../../services/auth/identity-bridge'
import { LOGIN_STATE_COOKIE, consumeLogin } from '../../services/auth/login-attempt'
import { safeRedirectPath } from '../../services/auth/redirect'
import { createSession } from '../../services/auth/session'

function sameString(a: string, b: string) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** 身份桥回调：校验 state → 换凭证 → 核查身份 → 建 30 天会话 → 回到原页面。 */
export default defineEventHandler(async (event) => {
  const { code, state, error } = getQuery(event)
  const cookieState = getCookie(event, LOGIN_STATE_COOKIE)
  deleteCookie(event, LOGIN_STATE_COOKIE, { path: '/auth/' })

  if (error) throw createError({ statusCode: 400, statusMessage: 'QMS 拒绝了登录授权' })
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    throw createError({ statusCode: 400, statusMessage: '回调缺少 code 或 state' })
  }
  if (!cookieState || !sameString(state, cookieState)) {
    throw createError({ statusCode: 400, statusMessage: '登录来源不符，请重新登录' })
  }
  const pending = await consumeLogin(prisma, state)
  if (!pending) throw createError({ statusCode: 400, statusMessage: '登录已过期或已使用，请重新登录' })

  const cfg = identityConfig(event)
  let identity
  let credential: string | undefined
  try {
    credential = await exchangeCode(cfg, { code, codeVerifier: pending.codeVerifier })
    identity = await verifyIdentity(cfg, credential)
  } catch (err) {
    if (err instanceof IdentityBridgeError) {
      console.error(`[auth] identity bridge ${err.stage} failed`, err.status ?? '', err.message)
      // 身份核查 401 = 账号停用或已删除（QMS 不返回 active:false）
      if (err.stage === 'identity' && err.status === 401) {
        throw createError({ statusCode: 403, statusMessage: '该 QMS 账号不可用或已停用' })
      }
      throw createError({ statusCode: 502, statusMessage: '登录失败：QMS 身份核查未通过，请重新登录' })
    }
    throw err
  } finally {
    // 履约有自己的会话，身份凭证只用这一次
    if (credential) await revokeCredential(cfg, credential)
  }
  if (!identity.active) throw createError({ statusCode: 403, statusMessage: '该 QMS 账号不可用或已停用' })

  const { token, expiresAt } = await createSession(prisma, { qmsUserId: identity.id, userName: identity.name })
  setSessionCookie(event, token, expiresAt)
  return sendRedirect(event, safeRedirectPath(pending.redirect), 302)
})
