/**
 * 每个请求解析一次会话，写入 event.context.user。
 * 未登录：接口返回 401；页面请求跳转 /auth/login 并带上原地址。
 */
import { SESSION_COOKIE, resolveSession } from '../services/auth/session'

const PUBLIC_PREFIXES = ['/auth/', '/api/health', '/_nuxt/', '/__nuxt', '/favicon']

function isPublic(path: string) {
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true
  // 带扩展名的静态文件放行；接口一律要登录，哪怕路径像文件名
  return !path.startsWith('/api/') && /\.[a-z0-9]+$/i.test(path)
}

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0] ?? '/'
  if (isPublic(path)) return

  const resolved = await resolveSession(prisma, getCookie(event, SESSION_COOKIE))
  if (resolved) {
    event.context.user = { qmsUserId: resolved.session.qmsUserId, name: resolved.session.userName }
    if (resolved.renewedExpiresAt) setSessionCookie(event, getCookie(event, SESSION_COOKIE)!, resolved.renewedExpiresAt)
    return
  }

  if (path.startsWith('/api/')) {
    throw createError({ statusCode: 401, statusMessage: '未登录' })
  }
  return sendRedirect(event, `/auth/login?redirect=${encodeURIComponent(event.path)}`, 302)
})
