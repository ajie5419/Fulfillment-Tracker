/**
 * 异常闭环（方案 5.2）：上报、受理、改派、填处理结果、确认关闭、退回、备注，以及列表和详情。
 *
 *   待受理 OPEN ──受理（可同时改责任人/要求解决日）──→ 处理中 ACCEPTED ──填处理结果──→ 待确认 RESOLVED ──确认关闭──→ 已关闭 CLOSED
 *                                                         ↑                                   │
 *                                                         └──────────────退回─────────────────┘
 *
 * 只有四个状态，不做会签、不做审批。每次状态变化、改派、备注都写 issue_log。
 * 状态迁移用 updateMany where {id, status: 期望状态} 做乐观并发：影响 0 行即"状态已变化，请刷新"，与写日志同一事务。
 * 谁能做什么集中在 issuePermissions 一个函数里。
 */
import type { Issue, IssueCategory, IssueSource, IssueStatus, NotifyRole, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { alertKey, dateFieldDay, judgeW4 } from '../alerts/rules'
import { FlowError, FlowForbidden } from '../flow/errors'
import { restoreBlockedStep } from '../flow/flow'
import { loadNames } from '../flow/names'
import {
  CATEGORY_TEXT,
  DEFAULT_DEPT_NAME,
  type IssueRefType,
  OPEN_STATUSES,
  STATUS_TEXT,
  SUPPLIER_CATEGORIES,
  defaultDueDate,
  formatIssueNo,
  issueNoPrefix,
  nextSeq,
} from './constants'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/** 操作人：QMS 用户 ID + 是否管理员（NUXT_ADMIN_USER_IDS，由接口层判断后传入） */
export interface Actor {
  userId: string
  isAdmin: boolean
}

export const MAX_PHOTOS = 3

const uniqueOn = (err: unknown, field: string) => {
  const e = err as { code?: string; meta?: { target?: unknown } }
  return e?.code === 'P2002' && String(e.meta?.target ?? '').includes(field)
}
/** 系统来源的异常撞上 sourceKey 唯一键：别处（并发的另一轮扫描）已经生成过 */
export const isSourceKeyConflict = (err: unknown) => uniqueOn(err, 'sourceKey')

/** 带编号冲突重试的事务：两个请求同时取到同一个当天序号时，后提交的撞唯一键，整个事务重来 */
export async function issueTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn)
    } catch (err) {
      if (attempt < 5 && uniqueOn(err, 'issueNo')) continue
      throw err
    }
  }
}

async function nextIssueNo(tx: Tx, now: Date) {
  const prefix = issueNoPrefix(now)
  const last = await tx.issue.findFirst({ where: { issueNo: { startsWith: prefix } }, orderBy: { issueNo: 'desc' }, select: { issueNo: true } })
  return formatIssueNo(prefix, nextSeq(prefix, last?.issueNo ?? null))
}

// ───────────── 责任部门与负责人 ─────────────

/** 部门负责人（notify_role 的 DEPT_HEAD，按部门名称对应），取第一个 */
async function deptHeadOf(db: Db, deptName: string | null | undefined) {
  if (!deptName) return null
  const head = await db.notifyRole.findFirst({ where: { role: 'DEPT_HEAD', department: deptName }, orderBy: { id: 'asc' }, select: { userId: true } })
  return head?.userId ?? null
}

/** 按分类默认的责任部门（按名称匹配 qms_department）和默认责任人（该部门负责人，没有则为空） */
export async function defaultResponsible(db: Db, category: IssueCategory) {
  const name = DEFAULT_DEPT_NAME[category]
  const dept = await db.qmsDepartment.findFirst({ where: { name, isDeleted: false }, orderBy: { id: 'asc' }, select: { id: true } })
  return { deptId: dept?.id ?? null, userId: await deptHeadOf(db, name) }
}

/** "本部门"筛选：我担任负责人的部门 + 我自己所在的部门，对应到 qms_department.id */
export async function myDepartmentIds(userId: string): Promise<string[]> {
  const [roles, user] = await Promise.all([
    prisma.notifyRole.findMany({ where: { userId, role: 'DEPT_HEAD' }, select: { department: true } }),
    prisma.qmsUser.findUnique({ where: { id: userId }, select: { department: true } }),
  ])
  const names = [...new Set([...roles.map((r) => r.department), user?.department].filter((x): x is string => !!x))]
  if (!names.length) return []
  return (await prisma.qmsDepartment.findMany({ where: { name: { in: names }, isDeleted: false }, select: { id: true } })).map((d) => d.id)
}

// ───────────── 权限（唯一入口）─────────────

interface PermContext {
  actor: Actor
  roles: NotifyRole[]
  deptName: Map<string, string>
  pmOf: Map<string, string | null>
}

async function loadPermContext(db: Db, actor: Actor, issues: Pick<Issue, 'responsibleDeptId' | 'workOrderNumber'>[]): Promise<PermContext> {
  const deptIds = [...new Set(issues.map((i) => i.responsibleDeptId).filter((x): x is string => !!x))]
  const wos = [...new Set(issues.map((i) => i.workOrderNumber))]
  const [roles, depts, exts] = await Promise.all([
    db.notifyRole.findMany({ where: { userId: actor.userId } }),
    deptIds.length ? db.qmsDepartment.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : [],
    wos.length ? db.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, projectManagerId: true } }) : [],
  ])
  return {
    actor,
    roles,
    deptName: new Map(depts.map((d) => [d.id, d.name])),
    pmOf: new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId])),
  }
}

export interface IssuePermissions {
  /** 受理（待受理 → 处理中）：责任人、责任部门负责人、管理员 */
  accept: boolean
  /** 填处理结果（处理中 → 待确认）：同受理 */
  resolve: boolean
  /** 改派责任部门/责任人/外协单位/要求解决日（待受理、处理中）：责任部门负责人、项目经理、项目部负责人、管理员 */
  reassign: boolean
  /** 确认关闭（待确认 → 已关闭）：上报人、项目经理、项目部负责人、管理员 */
  close: boolean
  /** 退回（待确认 → 处理中）：同确认关闭 */
  reject: boolean
  /** 加备注：能看到就能加 */
  note: boolean
}

export function issuePermissions(issue: Pick<Issue, 'status' | 'responsibleDeptId' | 'responsibleUserId' | 'reporterId' | 'workOrderNumber'>, ctx: PermContext): IssuePermissions {
  const uid = ctx.actor.userId
  const admin = ctx.actor.isAdmin
  const deptName = issue.responsibleDeptId ? ctx.deptName.get(issue.responsibleDeptId) : undefined
  const isDeptHead = !!deptName && ctx.roles.some((r) => r.role === 'DEPT_HEAD' && r.department === deptName)
  const isPM = ctx.pmOf.get(issue.workOrderNumber) === uid
  const isPDH = ctx.roles.some((r) => r.role === 'PROJECT_DEPT_HEAD')
  const isReporter = !!issue.reporterId && issue.reporterId === uid
  const handler = admin || issue.responsibleUserId === uid || isDeptHead
  const assigner = admin || isDeptHead || isPM || isPDH
  const confirmer = admin || isReporter || isPM || isPDH
  return {
    accept: issue.status === 'OPEN' && handler,
    resolve: issue.status === 'ACCEPTED' && handler,
    reassign: (issue.status === 'OPEN' || issue.status === 'ACCEPTED') && assigner,
    close: issue.status === 'RESOLVED' && confirmer,
    reject: issue.status === 'RESOLVED' && confirmer,
    note: true,
  }
}

type Action = Exclude<keyof IssuePermissions, 'note'>
const RULES: Record<Action, { from: IssueStatus[]; verb: string; denied: string }> = {
  accept: { from: ['OPEN'], verb: '受理', denied: '只有责任人、责任部门负责人或管理员可以受理' },
  resolve: { from: ['ACCEPTED'], verb: '填写处理结果', denied: '只有责任人、责任部门负责人或管理员可以填写处理结果' },
  reassign: { from: ['OPEN', 'ACCEPTED'], verb: '改派', denied: '只有责任部门负责人、该工单项目经理、项目部负责人或管理员可以改派' },
  close: { from: ['RESOLVED'], verb: '确认关闭', denied: '只有上报人、该工单项目经理、项目部负责人或管理员可以确认关闭' },
  reject: { from: ['RESOLVED'], verb: '退回', denied: '只有上报人、该工单项目经理、项目部负责人或管理员可以退回' },
}

/** 读出异常，检查状态和权限。状态不对 → 400；无权 → 403 */
async function guard(tx: Tx, id: string, actor: Actor, action: Action) {
  const issue = await tx.issue.findUnique({ where: { id } })
  if (!issue) throw new FlowError('异常不存在')
  const rule = RULES[action]
  if (!rule.from.includes(issue.status)) throw new FlowError(`该异常当前是"${STATUS_TEXT[issue.status]}"，不能${rule.verb}，请刷新`)
  const ctx = await loadPermContext(tx, actor, [issue])
  if (!issuePermissions(issue, ctx)[action]) throw new FlowForbidden(rule.denied)
  return issue
}

/** 乐观并发：只有状态仍是读到时的状态才更新；写日志。to 与原状态相同时（改派）日志不记状态 */
async function move(tx: Tx, issue: Issue, to: IssueStatus, data: Prisma.IssueUncheckedUpdateManyInput, note: string | null, actorId: string | null) {
  const r = await tx.issue.updateMany({ where: { id: issue.id, status: issue.status }, data: { ...data, status: to } })
  if (!r.count) throw new FlowError('状态已变化，请刷新')
  const changed = to !== issue.status
  await tx.issueLog.create({
    data: { issueId: issue.id, fromStatus: changed ? issue.status : null, toStatus: changed ? to : null, note, actorId },
  })
}

const joinNote = (parts: (string | null | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join('；') || null

// ───────────── 上报 ─────────────

export interface NewIssueInput {
  workOrderNumber: string
  partId?: string | null
  category: IssueCategory
  description: string
  photoIds?: string[]
  dueDate?: Date | null
  responsibleSupplierId?: string | null
}

async function assertSupplier(db: Db, category: IssueCategory, supplierId: string | null | undefined) {
  if (!supplierId) return null
  if (!SUPPLIER_CATEGORIES.includes(category)) throw new FlowError('只有"外协-进度""外协-质量"可以指定外协单位')
  const s = await db.qmsSupplier.findFirst({ where: { id: supplierId, isDeleted: false }, select: { id: true } })
  if (!s) throw new FlowError('外协单位不存在或已停用')
  return supplierId
}

/** 手工上报（来源 MANUAL）：按分类默认责任部门和责任人；照片只能用自己刚上传、还没被用过的 */
export async function createIssue(input: NewIssueInput, reporterId: string) {
  const description = input.description.trim()
  if (!description) throw new FlowError('请填写一句话描述')
  const photoIds = [...new Set(input.photoIds ?? [])]
  if (photoIds.length > MAX_PHOTOS) throw new FlowError(`照片最多 ${MAX_PHOTOS} 张`)
  return issueTransaction(async (tx) => {
    const wo = await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
    if (!wo) throw new FlowError('工单不存在或已删除')
    if (input.partId) {
      const part = await tx.part.findUnique({ where: { id: input.partId }, select: { workOrderNumber: true } })
      if (!part || part.workOrderNumber !== input.workOrderNumber) throw new FlowError('工件不存在或不属于该工单')
    }
    const supplierId = await assertSupplier(tx, input.category, input.responsibleSupplierId)
    const def = await defaultResponsible(tx, input.category)
    const issue = await tx.issue.create({
      data: {
        issueNo: await nextIssueNo(tx, new Date()),
        workOrderNumber: input.workOrderNumber,
        refType: input.partId ? ('PART' satisfies IssueRefType) : null,
        refId: input.partId || null,
        category: input.category,
        description,
        photos: photoIds,
        reporterId,
        source: 'MANUAL',
        responsibleDeptId: def.deptId,
        responsibleUserId: def.userId,
        responsibleSupplierId: supplierId,
        dueDate: input.dueDate ?? null,
      },
    })
    if (photoIds.length) {
      const bound = await tx.uploadFile.updateMany({ where: { id: { in: photoIds }, uploaderId: reporterId, issueId: null }, data: { issueId: issue.id } })
      if (bound.count !== photoIds.length) throw new FlowError('照片无效或已被使用，请重新上传')
    }
    await tx.issueLog.create({ data: { issueId: issue.id, toStatus: 'OPEN', note: '上报', actorId: reporterId } })
    return issue
  })
}

export interface SystemIssueInput {
  sourceKey: string
  source: Exclude<IssueSource, 'MANUAL'>
  category: IssueCategory
  workOrderNumber: string
  refType: IssueRefType
  refId: string
  description: string
  /** 不给时用分类默认责任部门的负责人 */
  responsibleUserId?: string | null
  responsibleSupplierId?: string | null
  /** 上报人：系统生成的为空；手动把黄色预警转异常时是点按钮的人 */
  reporterId?: string | null
  /** 第一条日志的操作人，系统为空 */
  actorId?: string | null
  /** 第一条日志 */
  note: string
}

/**
 * 系统生成的异常（QMS 不合格、预警转入），在调用方的事务里执行。系统生成的没有上报人。
 * sourceKey 唯一：重复生成会撞唯一键（调用方按"已存在"处理）。
 */
export async function createSystemIssue(tx: Tx, input: SystemIssueInput) {
  const def = await defaultResponsible(tx, input.category)
  const issue = await tx.issue.create({
    data: {
      issueNo: await nextIssueNo(tx, new Date()),
      workOrderNumber: input.workOrderNumber,
      refType: input.refType,
      refId: input.refId,
      category: input.category,
      description: input.description.slice(0, 2000),
      photos: [],
      reporterId: input.reporterId ?? null,
      source: input.source,
      sourceKey: input.sourceKey,
      responsibleDeptId: def.deptId,
      responsibleUserId: input.responsibleUserId || def.userId,
      responsibleSupplierId: input.responsibleSupplierId ?? null,
    },
  })
  await tx.issueLog.create({ data: { issueId: issue.id, toStatus: 'OPEN', note: input.note, actorId: input.actorId ?? null } })
  return issue
}

// ───────────── 受理、改派、处理、关闭、退回、备注 ─────────────

export interface AssignInput {
  responsibleDeptId?: string | null
  responsibleUserId?: string | null
  responsibleSupplierId?: string | null
  dueDate?: Date | null
}

/** 校验改派内容，返回要更新的字段和日志文字。undefined 表示不改 */
async function assignment(tx: Tx, issue: Issue, input: AssignInput) {
  const data: Prisma.IssueUncheckedUpdateManyInput = {}
  const text: string[] = []
  const deptIds = [issue.responsibleDeptId, input.responsibleDeptId].filter((x): x is string => !!x)
  const depts = deptIds.length ? await tx.qmsDepartment.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true, isDeleted: true } }) : []
  const deptName = (id: string | null | undefined) => (id ? (depts.find((d) => d.id === id)?.name ?? id) : '无')

  let userId = input.responsibleUserId
  if (input.responsibleDeptId !== undefined && input.responsibleDeptId !== issue.responsibleDeptId) {
    const dept = input.responsibleDeptId ? depts.find((d) => d.id === input.responsibleDeptId) : null
    if (input.responsibleDeptId && (!dept || dept.isDeleted)) throw new FlowError('责任部门不存在')
    data.responsibleDeptId = input.responsibleDeptId
    text.push(`责任部门 ${deptName(issue.responsibleDeptId)} → ${deptName(input.responsibleDeptId)}`)
    // 换了部门、没指定责任人：默认新部门的负责人
    if (userId === undefined) userId = await deptHeadOf(tx, dept?.name)
  }
  if (userId !== undefined && userId !== issue.responsibleUserId) {
    if (userId) {
      const u = await tx.qmsUser.findFirst({ where: { id: userId, isDeleted: false }, select: { id: true } })
      if (!u) throw new FlowError('责任人不存在')
    }
    data.responsibleUserId = userId
    const names = await loadNames({ user: [issue.responsibleUserId, userId] })
    const n = (id: string | null) => (id ? (names.user.get(id) ?? id) : '无')
    text.push(`责任人 ${n(issue.responsibleUserId)} → ${n(userId)}`)
  }
  if (input.responsibleSupplierId !== undefined && input.responsibleSupplierId !== issue.responsibleSupplierId) {
    data.responsibleSupplierId = await assertSupplier(tx, issue.category, input.responsibleSupplierId)
    const names = await loadNames({ supplier: [issue.responsibleSupplierId, input.responsibleSupplierId] })
    const n = (id: string | null | undefined) => (id ? (names.supplier.get(id) ?? id) : '无')
    text.push(`外协单位 ${n(issue.responsibleSupplierId)} → ${n(input.responsibleSupplierId)}`)
  }
  if (input.dueDate !== undefined && (input.dueDate?.getTime() ?? null) !== (issue.dueDate?.getTime() ?? null)) {
    data.dueDate = input.dueDate
    text.push(`要求解决日 ${issue.dueDate ? dateFieldDay(issue.dueDate) : '无'} → ${input.dueDate ? dateFieldDay(input.dueDate) : '无'}`)
  }
  return { data, text: text.join('，') }
}

/** 受理：待受理 → 处理中。没有要求解决日时默认 受理当天 + 3 天（工厂时区） */
export async function acceptIssue(id: string, actor: Actor, input: AssignInput & { note?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    const issue = await guard(tx, id, actor, 'accept')
    const { data, text } = await assignment(tx, issue, input)
    const due = 'dueDate' in data ? (data.dueDate as Date | null) : issue.dueDate
    let dueText: string | null = null
    if (!due) {
      data.dueDate = defaultDueDate(new Date())
      dueText = `要求解决日 ${dateFieldDay(data.dueDate as Date)}（默认受理后 3 天）`
    }
    await move(tx, issue, 'ACCEPTED', data, joinNote(['受理', text, dueText, input.note]), actor.userId)
    // "待受理超时"已解除：消除 W4，下一轮扫描按要求解决日重新判定（级别只升不降，不消除就会一直挂着）
    await clearAlertKeys(tx, [alertKey('W4', 'issue', id)])
    return { ok: true }
  })
}

/** 改派：待受理、处理中时改责任部门/责任人/外协单位/要求解决日，状态不变 */
export async function reassignIssue(id: string, actor: Actor, input: AssignInput & { note?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const issue = await guard(tx, id, actor, 'reassign')
    const { data, text } = await assignment(tx, issue, input)
    if (!text) throw new FlowError('没有修改任何内容')
    await move(tx, issue, issue.status, data, joinNote([`改派：${text}`, input.note]), actor.userId)
    // 改了要求解决日：按新日期重新判定 W4
    if ('dueDate' in data) await clearAlertKeys(tx, [alertKey('W4', 'issue', id)])
    return { ok: true }
  })
}

/** 填处理结果：处理中 → 待确认。待确认不算超期，消除 W4 */
export async function resolveIssue(id: string, actor: Actor, note: string) {
  if (!note.trim()) throw new FlowError('请填写处理结果')
  return prisma.$transaction(async (tx) => {
    const issue = await guard(tx, id, actor, 'resolve')
    await move(tx, issue, 'RESOLVED', {}, `处理结果：${note.trim()}`, actor.userId)
    await clearAlertKeys(tx, [alertKey('W4', 'issue', id)])
    return { ok: true }
  })
}

/** 退回：待确认 → 处理中 */
export async function rejectIssue(id: string, actor: Actor, note: string) {
  if (!note.trim()) throw new FlowError('请填写退回原因')
  return prisma.$transaction(async (tx) => {
    const issue = await guard(tx, id, actor, 'reject')
    await move(tx, issue, 'ACCEPTED', {}, `退回：${note.trim()}`, actor.userId)
    return { ok: true }
  })
}

/**
 * 确认关闭：待确认 → 已关闭。同一事务内：消除 W4；
 * 关联的是工序步骤（QMS 不合格）且该步骤没有其他未关闭异常时，步骤从"有异常"恢复。
 */
export async function closeIssue(id: string, actor: Actor, note?: string | null) {
  return prisma.$transaction(async (tx) => {
    const issue = await guard(tx, id, actor, 'close')
    await move(tx, issue, 'CLOSED', {}, joinNote(['确认关闭', note]), actor.userId)
    await clearAlertKeys(tx, [alertKey('W4', 'issue', id)])
    let stepRestored: string | null = null
    if (issue.refType === 'STEP' && issue.refId) {
      const others = await tx.issue.count({ where: { refType: 'STEP', refId: issue.refId, status: { not: 'CLOSED' }, id: { not: issue.id } } })
      if (!others) stepRestored = await restoreBlockedStep(tx, issue.refId)
    }
    return { ok: true, stepRestored }
  })
}

/** 备注：能看到这条异常的人都可以加，状态不变 */
export async function addIssueNote(id: string, actor: Actor, note: string) {
  if (!note.trim()) throw new FlowError('请填写备注')
  const issue = await prisma.issue.findUnique({ where: { id }, select: { id: true } })
  if (!issue) throw new FlowError('异常不存在')
  await prisma.issueLog.create({ data: { issueId: id, note: note.trim(), actorId: actor.userId } })
  return { ok: true }
}

// ───────────── 列表与详情 ─────────────

export interface IssueFilter {
  /** UNCLOSED = 未关闭（待受理、处理中、待确认） */
  status?: IssueStatus | 'UNCLOSED'
  category?: IssueCategory
  workOrderNumber?: string
  /** 本部门：责任部门在这些部门里 */
  deptIds?: string[]
  /** responsible = 我负责；reported = 我上报；todo = 等我操作（受理/处理/确认） */
  mine?: 'responsible' | 'reported' | 'todo'
  /** 只看超期（W4 意义上：待受理超 1 天或过要求解决日） */
  overdue?: boolean
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
}

const PAGE_LIMIT = 500

/** 给异常补上名称、关联对象文字、超期情况和当前用户可做的操作 */
async function decorate(issues: Issue[], actor: Actor, now: Date) {
  if (!issues.length) return []
  const [ctx, thresholds, offDays, depts] = await Promise.all([
    loadPermContext(prisma, actor, issues),
    loadThresholds(),
    loadOffDays(),
    prisma.qmsDepartment.findMany({ where: { id: { in: issues.map((i) => i.responsibleDeptId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ])
  const stepIds = issues.filter((i) => i.refType === 'STEP' && i.refId).map((i) => i.refId!)
  const partIds = issues.filter((i) => i.refType === 'PART' && i.refId).map((i) => i.refId!)
  const [steps, parts, alerts] = await Promise.all([
    stepIds.length ? prisma.routeStep.findMany({ where: { id: { in: stepIds } }, include: { part: { select: { id: true, name: true } } } }) : [],
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true } }) : [],
    prisma.alert.findMany({ where: { activeKey: { in: issues.map((i) => alertKey('W4', 'issue', i.id)) } }, select: { refId: true, level: true } }),
  ])
  const names = await loadNames({
    user: issues.flatMap((i) => [i.responsibleUserId, i.reporterId]),
    supplier: issues.map((i) => i.responsibleSupplierId),
    process: steps.map((s) => s.processId),
  })
  const deptName = new Map(depts.map((d) => [d.id, d.name]))
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const partById = new Map(parts.map((p) => [p.id, p]))
  const w4 = new Map(alerts.map((a) => [a.refId, a.level]))
  return issues.map((i) => {
    const step = i.refType === 'STEP' && i.refId ? stepById.get(i.refId) : undefined
    const part = step?.part ?? (i.refType === 'PART' && i.refId ? partById.get(i.refId) : undefined)
    const judged = judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, thresholds.W4)
    return {
      id: i.id,
      issueNo: i.issueNo,
      workOrderNumber: i.workOrderNumber,
      refType: i.refType,
      refId: i.refId,
      refText: step ? `${step.part.name} · ${names.process.get(step.processId) ?? step.processId}` : part ? part.name : null,
      partId: part?.id ?? null,
      stepId: step?.id ?? null,
      stepStatus: step?.status ?? null,
      category: i.category,
      categoryText: CATEGORY_TEXT[i.category],
      description: i.description,
      photoCount: Array.isArray(i.photos) ? i.photos.length : 0,
      source: i.source,
      reporterId: i.reporterId,
      reporterName: i.reporterId ? (names.user.get(i.reporterId) ?? i.reporterId) : null,
      responsibleDeptId: i.responsibleDeptId,
      responsibleDeptName: i.responsibleDeptId ? (deptName.get(i.responsibleDeptId) ?? i.responsibleDeptId) : null,
      responsibleUserId: i.responsibleUserId,
      responsibleUserName: i.responsibleUserId ? (names.user.get(i.responsibleUserId) ?? i.responsibleUserId) : null,
      responsibleSupplierId: i.responsibleSupplierId,
      responsibleSupplierName: i.responsibleSupplierId ? (names.supplier.get(i.responsibleSupplierId) ?? i.responsibleSupplierId) : null,
      dueDate: i.dueDate,
      status: i.status,
      statusText: STATUS_TEXT[i.status],
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      /** 超期：待受理超阈值、或过要求解决日（待确认、已关闭不算） */
      overdue: !!judged.level,
      overdueDays: judged.overdueDays,
      /** 当前 W4 预警级别（扫描任务写入的） */
      alertLevel: w4.get(i.id) ?? null,
      can: issuePermissions(i, ctx),
    }
  })
}

export type IssueRow = Awaited<ReturnType<typeof decorate>>[number]

export async function listIssues(filter: IssueFilter, actor: Actor, now = new Date()): Promise<IssueRow[]> {
  const where: Prisma.IssueWhereInput = {}
  if (filter.status === 'UNCLOSED') where.status = { in: OPEN_STATUSES }
  else if (filter.status) where.status = filter.status
  if (filter.category) where.category = filter.category
  const wo: Prisma.StringFilter = {}
  if (filter.visibleWorkOrders) wo.in = filter.visibleWorkOrders
  if (filter.workOrderNumber) wo.equals = filter.workOrderNumber
  if (Object.keys(wo).length) where.workOrderNumber = wo
  if (filter.deptIds) where.responsibleDeptId = { in: filter.deptIds }
  if (filter.mine === 'responsible') where.responsibleUserId = actor.userId
  if (filter.mine === 'reported') where.reporterId = actor.userId
  if (filter.mine === 'todo' && !where.status) where.status = { in: OPEN_STATUSES }
  const issues = await prisma.issue.findMany({ where, orderBy: [{ createdAt: 'desc' }], take: PAGE_LIMIT })
  let rows = await decorate(issues, actor, now)
  if (filter.mine === 'todo') rows = rows.filter((r) => r.can.accept || r.can.resolve || r.can.close)
  if (filter.overdue) rows = rows.filter((r) => r.overdue)
  // 未关闭在前，其中超期在前
  const rank = (r: IssueRow) => (r.status === 'CLOSED' ? 2 : r.overdue ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b) || +b.createdAt - +a.createdAt)
}

/** 详情：附处理日志（时间线）、照片地址 */
export async function getIssue(id: string, actor: Actor, now = new Date()) {
  const issue = await prisma.issue.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } } } })
  if (!issue) throw new FlowError('异常不存在')
  const [row] = await decorate([issue], actor, now)
  const names = await loadNames({ user: issue.logs.map((l) => l.actorId) })
  const photoIds = Array.isArray(issue.photos) ? (issue.photos as string[]) : []
  const converted = issue.source === 'ALERT' && issue.sourceKey ? await prisma.alert.findUnique({ where: { id: issue.sourceKey.slice('ALERT:'.length) }, select: { rule: true, level: true } }) : null
  return {
    ...row!,
    photos: photoIds.map((pid) => ({ id: pid, url: `/api/files/${pid}` })),
    fromAlert: converted,
    logs: issue.logs.map((l) => ({
      id: l.id,
      fromStatus: l.fromStatus,
      toStatus: l.toStatus,
      note: l.note,
      actorId: l.actorId,
      actorName: l.actorId ? (names.user.get(l.actorId) ?? l.actorId) : '系统',
      createdAt: l.createdAt,
    })),
  }
}

/** 某步骤上未关闭的异常（工件页"有异常"跳转用） */
export async function openIssuesOfSteps(stepIds: string[]) {
  if (!stepIds.length) return new Map<string, { id: string; issueNo: string }[]>()
  const rows = await prisma.issue.findMany({
    where: { refType: 'STEP', refId: { in: stepIds }, status: { not: 'CLOSED' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, issueNo: true, refId: true },
  })
  const out = new Map<string, { id: string; issueNo: string }[]>()
  for (const r of rows) out.set(r.refId!, [...(out.get(r.refId!) ?? []), { id: r.id, issueNo: r.issueNo }])
  return out
}

/** 上报页、改派用的下拉：分类（带默认部门）、部门 */
export async function issueOptions() {
  const depts = await prisma.qmsDepartment.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
  return {
    categories: (Object.keys(CATEGORY_TEXT) as IssueCategory[]).map((c) => ({
      value: c,
      label: CATEGORY_TEXT[c],
      deptName: DEFAULT_DEPT_NAME[c],
      supplier: SUPPLIER_CATEGORIES.includes(c),
    })),
    departments: depts,
  }
}
