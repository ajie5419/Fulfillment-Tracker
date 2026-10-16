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

/**
 * 数据可见性判断的唯一入口（技术选型 6.4 节 canSee(user, workOrder)）。
 * R3 只要求登录，一律返回 true；R4/R5 按角色和工单（项目经理、部门）收紧，届时只改这里。
 */
export function canSee(_user: AuthUser, _workOrderNumber: string | null): boolean {
  return true
}

export function assertCanSee(user: AuthUser, workOrderNumber: string | null = null) {
  if (!canSee(user, workOrderNumber)) throw createError({ statusCode: 403, statusMessage: '无权查看' })
}
