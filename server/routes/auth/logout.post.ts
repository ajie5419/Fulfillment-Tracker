import { SESSION_COOKIE, destroySession } from '../../services/auth/session'

export default defineEventHandler(async (event) => {
  await destroySession(prisma, getCookie(event, SESSION_COOKIE))
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return { ok: true }
})
