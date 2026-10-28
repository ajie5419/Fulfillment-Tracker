import type { H3Event } from 'h3'
import type { Prisma } from '@prisma/client'
import type { IdentityBridgeConfig } from '../services/auth/identity-bridge'
import { SESSION_COOKIE } from '../services/auth/session'
import { userBusinessDept } from '../services/auth/departments'
import { type Operation, type OperationTarget, OPERATION_DENIED, type RoleContext, canOperate, leaderTeamOfStep } from '../services/auth/permissions'
import { teamsLedBy } from '../services/flow/responsible'
import { FlowError, FlowForbidden } from '../services/flow/errors'
import { inspectionWorkOrders } from '../services/flow/inspection'
import { CONFIRM_PLAN_NODE, PLAN_REF } from '../services/plan/constants'
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
    roleContext?: RoleContext
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
/** db：在事务里调用时传事务客户端（同一连接、看得到本事务未提交的写入） */
export async function resolveScope(userId: string, admin: boolean, db: Pick<Prisma.TransactionClient, 'notifyRole' | 'workOrderExt'> = prisma): Promise<Scope> {
  if (admin) return { all: true }
  const [role, managed] = await Promise.all([
    db.notifyRole.findFirst({ where: { userId }, select: { id: true } }),
    db.workOrderExt.findMany({ where: { projectManagerId: userId }, select: { workOrderNumber: true } }),
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

/** 采购行、付款申请（R10）：按所属工单判断 */
export async function assertCanSeePurchase(event: H3Event, id: string) {
  const line = await prisma.purchaseLine.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (line) await assertCanSee(event, line.workOrderNumber)
}

export async function assertCanSeePayment(event: H3Event, id: string) {
  const p = await prisma.paymentRequest.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (p) await assertCanSee(event, p.workOrderNumber)
}

/**
 * 工艺模块（料单、工艺状态）：按设计任务所属工单判断。设计任务不存在时直接报"不存在"，不跳过可见性校验（规则 10-26 #37）
 */
export async function assertCanSeeProcess(event: H3Event, id: string) {
  const task = await prisma.drawingTask.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (!task) throw new FlowError('设计任务不存在')
  await assertCanSee(event, task.workOrderNumber)
}

/**
 * 设计任务（R11）：按所属工单判断；给了 user 时，设计负责人本人不受工单范围限制（"我的设计任务"）。
 * 修改类接口不传 user：负责人本人也要能看到该工单才能改。
 */
export async function assertCanSeeDrawing(event: H3Event, id: string, user?: AuthUser) {
  const task = await prisma.drawingTask.findUnique({ where: { id }, select: { workOrderNumber: true, ownerId: true } })
  if (!task) return
  if (user && task.ownerId === user.qmsUserId) return
  await assertCanSee(event, task.workOrderNumber)
}

/**
 * 装配节点（R12）：按所属工单判断；给了 user 时，节点负责人本人不受工单范围限制（手机"我负责的节点"、W8 提醒跳转）。
 * 修改类接口不传 user（另外还要是生产经理 / 该工单项目经理 / 管理员，服务层判断）。
 */
export async function assertCanSeeNode(event: H3Event, id: string, user?: AuthUser) {
  const node = await prisma.assemblyNode.findUnique({ where: { id }, select: { workOrderNumber: true, ownerId: true } })
  if (!node) return
  if (user && node.ownerId === user.qmsUserId) return
  await assertCanSee(event, node.workOrderNumber)
}

/** 报检：主工单或任一关联工单可见即可见 */
export async function assertCanSeeInspection(event: H3Event, inspectionId: string) {
  const ins = await prisma.qmsInspection.findUnique({ where: { id: inspectionId }, select: { workOrderNumber: true, workOrderNumbers: true } })
  if (!ins) return
  const scope = await getScope(event)
  if (!inspectionWorkOrders(ins).some((wo) => canSee(scope, wo))) throw forbidden()
}

// ───────────── 角色与操作权限（权限方案 R13）─────────────
//
// 角色上下文一次算出：管理员、通知角色、担任负责人的部门、本人业务部门（QMS 部门经 dept_mapping 换算）、担任项目经理的工单。
// 规则在 services/auth/permissions.ts（纯函数）；这里只负责按请求加载和缓存，以及"无权 → 403"。
// 只用于用户发起的接口；QMS 同步、报检匹配自动到货、自动转序等后台流程直接调服务，不经过这里。

/** 按用户算角色上下文（不依赖请求） */
export async function loadRoleContext(userId: string, admin: boolean): Promise<RoleContext> {
  const [roles, managed, businessDept, leadOf] = await Promise.all([
    prisma.notifyRole.findMany({ where: { userId }, select: { role: true, department: true } }),
    prisma.workOrderExt.findMany({ where: { projectManagerId: userId }, select: { workOrderNumber: true } }),
    userBusinessDept(userId),
    teamsLedBy(prisma, userId),
  ])
  return {
    userId,
    isAdmin: admin,
    roles: [...new Set(roles.map((r) => r.role))],
    deptHeadOf: [...new Set(roles.filter((r) => r.role === 'DEPT_HEAD' && r.department).map((r) => r.department!))],
    businessDept,
    pmOf: new Set(managed.map((m) => m.workOrderNumber)),
    leadOf,
  }
}

/** 当前请求用户的角色上下文（按请求缓存，像 getScope 一样） */
export async function getRoleContext(event: H3Event): Promise<RoleContext> {
  if (event.context.roleContext) return event.context.roleContext
  const user = requireUser(event)
  const ctx = await loadRoleContext(user.qmsUserId, isAdmin(event, user))
  event.context.roleContext = ctx
  return ctx
}

/** 无权做该操作时抛 FlowForbidden（defineFlowHandler 转成 403 + 中文提示） */
export async function assertCanOperate(event: H3Event, op: Operation, target: OperationTarget = {}) {
  if (!canOperate(await getRoleContext(event), op, target)) throw new FlowForbidden(OPERATION_DENIED[op])
}

/** 工件所属工单上的操作（工件不存在时不拦，由服务层报"不存在"） */
export async function assertCanOperatePart(event: H3Event, op: Operation, partId: string) {
  const part = await prisma.part.findUnique({ where: { id: partId }, select: { workOrderNumber: true } })
  if (part) await assertCanOperate(event, op, { workOrderNumber: part.workOrderNumber })
}

/**
 * 工序上的操作：带上工序所属工单和工序责任人。
 * teamLeader：本班组班组长也可以（开工、完工、报工这几个接口传 true；发出、补登返厂不传）——只对自制工序生效。
 */
export async function assertCanOperateStep(event: H3Event, op: Operation, stepId: string, opts: { teamLeader?: boolean } = {}) {
  const step = await prisma.routeStep.findUnique({ where: { id: stepId }, select: { ownerId: true, mode: true, supplierId: true, part: { select: { workOrderNumber: true } } } })
  if (step) {
    await assertCanOperate(event, op, {
      workOrderNumber: step.part.workOrderNumber,
      ownerId: step.ownerId,
      teamId: opts.teamLeader ? leaderTeamOfStep(step) : null,
    })
  }
}

/** 采购行上的操作 */
export async function assertCanOperatePurchase(event: H3Event, id: string) {
  const line = await prisma.purchaseLine.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (line) await assertCanOperate(event, 'purchase', { workOrderNumber: line.workOrderNumber })
}

/** 设计任务上的编辑 */
export async function assertCanOperateDrawing(event: H3Event, id: string) {
  const task = await prisma.drawingTask.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (task) await assertCanOperate(event, 'drawing', { workOrderNumber: task.workOrderNumber })
}

/** 待确认匹配（报检）上的处理：主工单或任一关联工单的项目经理也算 */
export async function assertCanOperateInspection(event: H3Event, inspectionId: string) {
  const ins = await prisma.qmsInspection.findUnique({ where: { id: inspectionId }, select: { workOrderNumber: true, workOrderNumbers: true } })
  if (ins) await assertCanOperate(event, 'route', { workOrderNumbers: inspectionWorkOrders(ins) })
}

// ───────────── 总计划（R14）─────────────

/** 手里有"确认总计划节点"待办（含转交来的）：nodeId 给定时看这个节点，否则看该工单任一节点 */
async function holdsConfirmTodo(userId: string, where: { nodeId?: string; workOrderNumber?: string }) {
  let refIds: string[]
  if (where.nodeId) refIds = [where.nodeId]
  else refIds = (await prisma.planNode.findMany({ where: { workOrderNumber: where.workOrderNumber }, select: { id: true } })).map((n) => n.id)
  if (!refIds.length) return false
  const todo = await prisma.todo.findFirst({ where: { refType: PLAN_REF, refId: { in: refIds }, action: CONFIRM_PLAN_NODE, ownerId: userId, status: 'OPEN' }, select: { id: true } })
  return !!todo
}

/**
 * 总计划节点：按所属工单判断可见（节点不存在时不拦，由服务层报"不存在"）。
 * 手里有该节点确认待办的人即使工单不在可见范围（如被转交给只管别的工单的项目经理）也能看到这个节点。
 */
export async function assertCanSeePlanNode(event: H3Event, id: string) {
  const node = await prisma.planNode.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (!node) return
  if (canSee(await getScope(event), node.workOrderNumber)) return
  if (await holdsConfirmTodo(requireUser(event).qmsUserId, { nodeId: id })) return
  throw forbidden()
}

/** 总计划页：能看到该工单，或手里有该工单某个节点的确认待办 */
export async function assertCanSeePlan(event: H3Event, workOrderNumber: string) {
  if (canSee(await getScope(event), workOrderNumber)) return
  if (await holdsConfirmTodo(requireUser(event).qmsUserId, { workOrderNumber })) return
  throw forbidden()
}

/**
 * 总计划节点上的操作：plan（改 / 删节点）—— 该工单项目经理、项目部、管理员；planNodeDone（手动完成 / 撤销）—— 该节点责任部门的人、该工单项目经理、管理员；
 * planConfirm（确认 / 退回）—— 该节点责任部门负责人、管理员，另外手里有这个节点"确认总计划节点"待办的人（转交来的）也可以。
 */
export async function assertCanOperatePlanNode(event: H3Event, op: Extract<Operation, 'plan' | 'planNodeDone' | 'planConfirm' | 'planTask'>, id: string) {
  const node = await prisma.planNode.findUnique({ where: { id }, select: { workOrderNumber: true, dept: true } })
  if (!node) return
  const ctx = await getRoleContext(event)
  if (canOperate(ctx, op, { workOrderNumber: node.workOrderNumber, dept: node.dept })) return
  if (op === 'planConfirm') {
    const todo = await prisma.todo.findFirst({ where: { refType: PLAN_REF, refId: id, action: CONFIRM_PLAN_NODE, ownerId: ctx.userId, status: 'OPEN' }, select: { id: true } })
    if (todo) return
  }
  throw new FlowForbidden(OPERATION_DENIED[op])
}

/** 其他任务（部门计划二次分解）：按所属工单判断可见；任务负责人本人始终能看（工单不在可见范围也能处理自己的任务）。任务不存在时不拦 */
export async function assertCanSeePlanTask(event: H3Event, id: string) {
  const t = await prisma.planTask.findUnique({ where: { id }, select: { workOrderNumber: true, ownerId: true } })
  if (!t) return
  if (t.ownerId === requireUser(event).qmsUserId) return
  if (canSee(await getScope(event), t.workOrderNumber)) return
  throw forbidden()
}

/** 其他任务上的操作（planTask：节点责任部门的人、项目经理、项目部、管理员）；allowOwner = 任务负责人本人也可以（标完成 / 撤销） */
export async function assertCanOperatePlanTask(event: H3Event, id: string, opts: { allowOwner?: boolean } = {}) {
  const t = await prisma.planTask.findUnique({ where: { id }, select: { workOrderNumber: true, ownerId: true, planNode: { select: { dept: true } } } })
  if (!t) return
  const ctx = await getRoleContext(event)
  if (opts.allowOwner && t.ownerId === ctx.userId) return
  if (canOperate(ctx, 'planTask', { workOrderNumber: t.workOrderNumber, dept: t.planNode.dept })) return
  throw new FlowForbidden(OPERATION_DENIED.planTask)
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
