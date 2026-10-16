import type { H3Event } from 'h3'
import type { IdentityBridgeConfig } from '../services/auth/identity-bridge'
import { SESSION_COOKIE } from '../services/auth/session'

export interface AuthUser {
  qmsUserId: string
  name: string
}

declare module 'h3' {
  interface H3EventContext {
    user?: AuthUser
  }
}

export function identityConfig(event: H3Event): IdentityBridgeConfig {
  const { qms } = useRuntimeConfig(event)
  return {
    apiBase: qms.apiBase,
    authorizeUrl: qms.authorizeUrl,
    clientId: qms.clientId,
    clientSecret: qms.clientSecret,
    callbackUrl: qms.callbackUrl,
  }
}

export function setSessionCookie(event: H3Event, token: string, expiresAt: Date) {
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export function requireUser(event: H3Event): AuthUser {
  const user = event.context.user
  if (!user) throw createError({ statusCode: 401, statusMessage: '未登录' })
  return user
}
