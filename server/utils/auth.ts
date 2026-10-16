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

/** 管理员：NUXT_ADMIN_USER_IDS 里列出的 QMS 用户 ID（逗号分隔）。设置页的接口都用它校验 */
export function isAdmin(event: H3Event, user: AuthUser): boolean {
  const ids = String(useRuntimeConfig(event).adminUserIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return ids.includes(user.qmsUserId)
}

export function requireAdmin(event: H3Event): AuthUser {
  const user = requireUser(event)
  if (!isAdmin(event, user)) throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: '仅管理员可操作' })
  return user
}
