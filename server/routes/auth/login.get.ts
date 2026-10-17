import { buildAuthorizeUrl } from '../../services/auth/identity-bridge'
import { LOGIN_STATE_COOKIE, LOGIN_TTL_MS, startLogin } from '../../services/auth/login-attempt'
import { safeRedirectPath } from '../../services/auth/redirect'

/**
 * 跳转 QMS 授权页。state 同时写入本浏览器 Cookie，回调时比对，防止登录 CSRF。
 * ?prompt=login：要求 QMS 重新输入账号密码（退出后换人登录用；QMS 已登录时默认会直接放行）。
 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const redirect = safeRedirectPath(q.redirect)
  const forceLogin = q.prompt === 'login'
  const { state, codeChallenge } = await startLogin(prisma, redirect)
  setCookie(event, LOGIN_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/auth/',
    maxAge: LOGIN_TTL_MS / 1000,
  })
  return sendRedirect(event, buildAuthorizeUrl(identityConfig(event), { state, codeChallenge, forceLogin }), 302)
})
