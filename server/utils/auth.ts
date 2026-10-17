import type { H3Event } from 'h3'
import type { IdentityBridgeConfig } from '../services/auth/identity-bridge'
import { SESSION_COOKIE } from '../services/auth/session'
import { inspectionWorkOrders } from '../services/flow/inspection'
import { prisma } from './prisma'

export interface AuthUser {
  qmsUserId: string
  name: string
}

/**
 * 数据可见范围：all = 全部工单；否则只能看 workOrders 里的工单（项目经理只看自己负责的）。
 * 每个请求只算一次（缓存在 event.context.scope），单对象检查和列表过滤都用它。
 */
export type Scope = { all: true } | { all: false; workOrders: Set<string> }

declare module 'h3' {
  interface H3EventContext {
    user?: AuthUser
    scope?: Scope
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

// ───────────── 数据可见性（技术选型 6.4 节 canSee(user, workOrder)，方案 7.3）─────────────
//
// 这里是唯一入口，接口和服务的列表过滤都从这里拿可见范围：
//   管理员、分管领导、项目部负责人、外协专员、部门负责人（notify_role 里有任何角色）→ 全部工单；
//   不是任何工单项目经理的普通用户（一线、生产经理）→ 全部工单（方案 7.3"第一期不细分"）；
//   只有"是至少一个工单的项目经理、且没有上述任何角色、不是管理员"时，只能看自己负责的工单。
// 部门负责人"看本部门"不做硬限制，做成异常列表的默认筛选（可切换全部）。

/** 按用户算可见范围（不依赖请求，后台任务如每日汇总也用它） */
export async function resolveScope(userId: string, admin: boolean): Promise<Scope> {
  if (admin) return { all: true }
  const [role, managed] = await Promise.all([
    prisma.notifyRole.findFirst({ where: { userId }, select: { id: true } }),
    prisma.workOrderExt.findMany({ where: { projectManagerId: userId }, select: { workOrderNumber: true } }),
  ])
  if (role || !managed.length) return { all: true }
  return { all: false, workOrders: new Set(managed.map((m) => m.workOrderNumber)) }
}

/** 当前请求用户的可见范围（按请求缓存） */
export async function getScope(event: H3Event): Promise<Scope> {
  if (event.context.scope) return event.context.scope
  const user = requireUser(event)
  const scope = await resolveScope(user.qmsUserId, isAdmin(event, user))
  event.context.scope = scope
  return scope
}

/** 单个工单是否可见。workOrderNumber 为 null 表示"不针对具体工单"（只要求登录） */
export function canSee(scope: Scope, workOrderNumber: string | null): boolean {
  if (scope.all || workOrderNumber === null) return true
  return scope.workOrders.has(workOrderNumber)
}

/** 列表查询用：全部可见时返回 undefined（不加条件），否则返回可见工单号 */
export function scopeWorkOrders(scope: Scope): string[] | undefined {
  return scope.all ? undefined : [...scope.workOrders]
}

const forbidden = () => createError({ statusCode: 403, statusMessage: 'Forbidden', message: '无权查看该工单的数据' })

export async function assertCanSee(event: H3Event, workOrderNumber: string | null = null) {
  if (!canSee(await getScope(event), workOrderNumber)) throw forbidden()
}

/** 按对象找到所属工单再判断；对象不存在时不拦（由服务层报"不存在"） */
export async function assertCanSeePart(event: H3Event, partId: string) {
  const part = await prisma.part.findUnique({ where: { id: partId }, select: { workOrderNumber: true } })
  if (part) await assertCanSee(event, part.workOrderNumber)
}

export async function assertCanSeeStep(event: H3Event, stepId: string) {
  const step = await prisma.routeStep.findUnique({ where: { id: stepId }, select: { part: { select: { workOrderNumber: true } } } })
  if (step) await assertCanSee(event, step.part.workOrderNumber)
}

export async function assertCanSeeIssue(event: H3Event, issueId: string) {
  const issue = await prisma.issue.findUnique({ where: { id: issueId }, select: { workOrderNumber: true } })
  if (issue) await assertCanSee(event, issue.workOrderNumber)
}

/** 报检：主工单或任一关联工单可见即可见 */
export async function assertCanSeeInspection(event: H3Event, inspectionId: string) {
  const ins = await prisma.qmsInspection.findUnique({ where: { id: inspectionId }, select: { workOrderNumber: true, workOrderNumbers: true } })
  if (!ins) return
  const scope = await getScope(event)
  if (!inspectionWorkOrders(ins).some((wo) => canSee(scope, wo))) throw forbidden()
}

/** 管理员：NUXT_ADMIN_USER_IDS 里列出的 QMS 用户 ID（逗号分隔）。设置页的接口都用它校验 */
export function adminIds(event?: H3Event): string[] {
  return String(useRuntimeConfig(event).adminUserIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isAdmin(event: H3Event, user: AuthUser): boolean {
  return adminIds(event).includes(user.qmsUserId)
}

export function requireAdmin(event: H3Event): AuthUser {
  const user = requireUser(event)
  if (!isAdmin(event, user)) throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: '仅管理员可操作' })
  return user
}
