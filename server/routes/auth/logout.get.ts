import { SESSION_COOKIE, destroySession } from '../../services/auth/session'

/** Direct logout links also invalidate the server session before returning to login. */
export default defineEventHandler(async (event) => {
  await destroySession(prisma, getCookie(event, SESSION_COOKIE))
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return sendRedirect(event, '/auth/login', 302)
})
