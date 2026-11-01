import type { Issue, IssueCategory, IssueStatus, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { MAX_ISSUE_PHOTOS } from '../../../shared/upload-policy'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey, dateFieldDay } from '../alerts/rules'
import { loadDeptIndex, resolveDeptName } from '../auth/departments'
import { FlowError, FlowForbidden } from '../flow/errors'
import { lockStep, restoreBlockedStep } from '../flow/flow'
import { loadNames } from '../flow/names'
import { type IssueRefType, STATUS_TEXT, SUPPLIER_CATEGORIES, defaultDueDate } from './constants'
import type { Tx, Db, Actor, IssuePermissions, NewIssueInput, SystemIssueInput, AssignInput } from './types'
import { issueTransaction, nextIssueNo } from './transaction'
import { defaultResponsible, deptHeadOf } from './responsibility'
import { issuePermissions, joinNote } from './calculation'
import { loadPermContext } from './loaders'

export const MAX_PHOTOS = MAX_ISSUE_PHOTOS

type Action = Exclude<keyof IssuePermissions, 'note'>

const RULES: Record<Action, { from: IssueStatus[]; verb: string; denied: string }> = {
  accept: { from: ['OPEN'], verb: '受理', denied: '只有责任人、责任部门负责人、未指定责任人时的上报人或管理员可以受理' },
  resolve: { from: ['ACCEPTED'], verb: '填写处理结果', denied: '只有责任人、责任部门负责人或管理员可以填写处理结果' },
  reassign: { from: ['OPEN', 'ACCEPTED'], verb: '改派', denied: '只有责任部门负责人、该工单项目经理、项目部负责人或管理员可以改派' },
  close: { from: ['RESOLVED'], verb: '确认关闭', denied: '只有上报人、该工单项目经理、项目部负责人或管理员可以确认关闭' },
  reject: { from: ['RESOLVED'], verb: '退回', denied: '只有上报人、该工单项目经理、项目部负责人或管理员可以退回' },
}

/** 读出异常，检查状态和权限。状态不对 → 409；无权 → 403 */
async function guard(tx: Tx, id: string, actor: Actor, action: Action) {
  const issue = await tx.issue.findUnique({ where: { id } })
  if (!issue) throw new FlowError('异常不存在', 'NOT_FOUND')
  const rule = RULES[action]
  if (!rule.from.includes(issue.status)) throw new FlowError(`该异常当前是"${STATUS_TEXT[issue.status]}"，不能${rule.verb}，请刷新`, 'CONFLICT')
  const ctx = await loadPermContext(tx, actor, [issue])
  if (!issuePermissions(issue, ctx)[action]) throw new FlowForbidden(rule.denied)
  return issue
}

/** 乐观并发：只有状态仍是读到时的状态才更新；写日志。to 与原状态相同时（改派）日志不记状态 */
async function move(tx: Tx, issue: Issue, to: IssueStatus, data: Prisma.IssueUncheckedUpdateManyInput, note: string | null, actorId: string | null) {
  const r = await tx.issue.updateMany({ where: { id: issue.id, status: issue.status }, data: { ...data, status: to } })
  if (!r.count) throw new FlowError('状态已变化，请刷新', 'CONFLICT')
  const changed = to !== issue.status
  await tx.issueLog.create({
    data: { issueId: issue.id, fromStatus: changed ? issue.status : null, toStatus: changed ? to : null, note, actorId },
  })
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
  if (!description) throw new FlowError('请填写一句话描述', 'VALIDATION')
  const photoIds = [...new Set(input.photoIds ?? [])]
  if (photoIds.length > MAX_PHOTOS) throw new FlowError(`照片最多 ${MAX_PHOTOS} 张`, 'VALIDATION')
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
        title: input.title?.trim() || null,
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
      // 只认图片（PDF 是发放单附件），已绑定到发放单的也不能再用
      const bound = await tx.uploadFile.updateMany({
        where: { id: { in: photoIds }, uploaderId: reporterId, issueId: null, releaseId: null, mime: { startsWith: 'image/' } },
        data: { issueId: issue.id },
      })
      if (bound.count !== photoIds.length) throw new FlowError('照片无效或已被使用，请重新上传')
    }
    await tx.issueLog.create({ data: { issueId: issue.id, toStatus: 'OPEN', note: '上报', actorId: reporterId } })
    return issue
  })
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
    // 换了部门、没指定责任人：按业务部门名称查新部门的负责人
    if (userId === undefined) {
      const name = dept ? resolveDeptName(dept.id, await loadDeptIndex()) : null
      userId = await deptHeadOf(tx, name)
    }
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
    // Unassigned issues belong to the person accepting them unless explicitly assigned.
    if (!issue.responsibleUserId && input.responsibleUserId === undefined) data.responsibleUserId = actor.userId
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
  const ref = await prisma.issue.findUnique({ where: { id }, select: { refType: true, refId: true } })
  return prisma.$transaction(async (tx) => {
    // Match return/rejection lock order (part, then step), and serialize closes before counting remaining issues.
    if (ref?.refType === 'STEP' && ref.refId) await lockStep(tx, ref.refId)
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
  if (!issue) throw new FlowError('异常不存在', 'NOT_FOUND')
  await prisma.issueLog.create({ data: { issueId: id, note: note.trim(), actorId: actor.userId } })
  return { ok: true }
}
