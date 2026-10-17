/**
 * 发放签收 + 设计变更通知（R9）：发放单（图纸 / 设计变更 / 工艺文件）登记"发给谁"，每个接收人一条签收记录 + 一条签收待办；
 * 接收人在手机或电脑上签收，或拒收并写原因（拒收通知发放人）。超时没签收由 W5 预警（scan.ts）。
 *
 * 设计变更关联的工件：
 *   已在加工 / 在外协的工序 → 给生产经理（生产部负责人）和外协专员发"确认变更影响"待办；
 *   还没开工的工序 → 标"等变更"（route_step.holdReleaseId），W2/W3 不计时；
 *   确认变更影响（任一收到待办的人、发放人或管理员点确认）后解除；没有在加工的工序（没发确认待办）时，接收人全部签收即自动解除。
 *
 * 不做审批、不做会签：发放人发出即生效；发错了由发放人或管理员作废（未签收的一并作废）。
 * 状态变化都在一个事务里，先锁发放单行（FOR UPDATE），同一发放单上的签收、作废、确认串行执行。
 */
import type { Prisma, ReceiptStatus, Release, ReleaseType } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey } from '../alerts/rules'
import { FlowError, FlowForbidden } from '../flow/errors'
import { departmentNames, loadNames, userDepartmentNames } from '../flow/names'
import { formatIssueNo, nextSeq } from '../issues/constants'
import {
  CONFIRM_CHANGE,
  MAX_ATTACHMENTS,
  MAX_RECIPIENTS,
  PRODUCTION_DEPT,
  RECEIPT_STATUS_TEXT,
  type RecipientGroup,
  SIGN_RELEASE,
  STEP_STATUS_TEXT,
  TYPE_TEXT,
  groupLabel,
  partIdsOf,
  releaseLink,
  releaseNoPrefix,
  resolveGroup,
  splitAffectedSteps,
} from './constants'

type Tx = Prisma.TransactionClient

export interface Actor {
  userId: string
  isAdmin: boolean
}

const uniq = <T>(xs: T[]) => [...new Set(xs)]

/** 编号冲突重试：两个请求同时取到同一个当天序号时，后提交的撞唯一键，整个事务重来 */
async function releaseTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn)
    } catch (err) {
      const e = err as { code?: string; meta?: { target?: unknown } }
      if (attempt < 5 && e?.code === 'P2002' && String(e.meta?.target ?? '').includes('releaseNo')) continue
      throw err
    }
  }
}

async function nextReleaseNo(tx: Tx, now: Date) {
  const prefix = releaseNoPrefix(now)
  const last = await tx.release.findFirst({ where: { releaseNo: { startsWith: prefix } }, orderBy: { releaseNo: 'desc' }, select: { releaseNo: true } })
  return formatIssueNo(prefix, nextSeq(prefix, last?.releaseNo ?? null))
}

/** 先锁发放单行再读（锁是事务里第一条语句，之后的普通读看到的是加锁后的最新数据） */
async function lockRelease(tx: Tx, id: string): Promise<Release> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM doc_release WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('发放单不存在')
  return tx.release.findUniqueOrThrow({ where: { id } })
}

/** 解除这张发放单打的"等变更"（被更新的变更单覆盖过的不动），记下解除时间供 W2 重新计时 */
async function clearHolds(tx: Tx, releaseId: string, now: Date) {
  const r = await tx.routeStep.updateMany({ where: { holdReleaseId: releaseId }, data: { holdReleaseId: null, holdClearedAt: now } })
  return r.count
}

// ───────────── 接收人 ─────────────

/**
 * 按人 + 按"部门 + 角色"展开成接收人（去重）。按人选的必须在职；按部门/角色展开时不含发放人自己、跳过不在职的。
 * 某个"部门 + 角色"一个人都没有时报错，免得发放人以为发出去了。
 */
export async function resolveRecipients(userIds: string[], groups: RecipientGroup[], issuerId: string): Promise<string[]> {
  const out = new Set<string>()
  const picked = uniq(userIds)
  if (picked.length) {
    const found = await prisma.qmsUser.findMany({ where: { id: { in: picked }, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
    if (found.length !== picked.length) throw new FlowError('有接收人不存在或已停用，请重新选择')
    for (const u of found) out.add(u.id)
  }
  if (groups.length) {
    const [users, roles] = await Promise.all([
      prisma.qmsUser.findMany({ where: { isDeleted: false, status: 'ACTIVE' }, select: { id: true, departmentId: true } }),
      prisma.notifyRole.findMany({ select: { role: true, userId: true, department: true } }),
    ])
    const depts = await departmentNames(users.map((u) => u.departmentId))
    const ctx = { users: users.map((u) => ({ id: u.id, deptName: (u.departmentId && depts.get(u.departmentId)) || null })), roles }
    for (const g of groups) {
      if (!g.department?.trim() && !g.role) throw new FlowError('按部门/角色选人时，部门和角色至少选一个')
      const ids = resolveGroup(g, ctx).filter((id) => id !== issuerId)
      if (!ids.length) throw new FlowError(`按"${groupLabel(g)}"没有找到接收人（不含你自己）`)
      for (const id of ids) out.add(id)
    }
  }
  if (!out.size) throw new FlowError('请选择接收人')
  if (out.size > MAX_RECIPIENTS) throw new FlowError(`接收人太多（${out.size} 人），一次最多 ${MAX_RECIPIENTS} 人`)
  return [...out]
}

// ───────────── 新建 ─────────────

export interface NewReleaseInput {
  type: ReleaseType
  workOrderNumber: string
  partIds?: string[]
  version?: string | null
  description: string
  attachmentIds?: string[]
  userIds?: string[]
  groups?: RecipientGroup[]
}

export interface ChangeImpact {
  /** 已在加工 / 在外协的工序数（> 0 时发了"确认变更影响"待办） */
  started: number
  /** 标了"等变更"的未开工工序数 */
  held: number
  /** 收到"确认变更影响"待办的人 */
  confirmers: string[]
}

/**
 * 设计变更的影响：已开工的 → 生产经理 + 外协专员各一条"确认变更影响"待办（都没配置时交给发放人自己）；
 * 未开工的 → 标"等变更"，并立即消除它们上面的 W2/W3 预警（扫描任务也会兜底）。
 */
async function applyChangeImpact(tx: Tx, release: Release, partIds: string[]): Promise<ChangeImpact> {
  const steps = await tx.routeStep.findMany({ where: { partId: { in: partIds } }, select: { id: true, status: true } })
  const { started, hold } = splitAffectedSteps(steps)
  let confirmers: string[] = []
  if (started.length) {
    const roles = await tx.notifyRole.findMany({
      where: { OR: [{ role: 'OUTSOURCE_COORDINATOR' }, { role: 'DEPT_HEAD', department: PRODUCTION_DEPT }] },
      select: { userId: true },
    })
    confirmers = uniq(roles.map((r) => r.userId))
    if (!confirmers.length) confirmers = [release.issuerId]
    await tx.todo.createMany({ data: confirmers.map((ownerId) => ({ ownerId, action: CONFIRM_CHANGE, refType: 'release', refId: release.id })) })
  }
  let held = 0
  if (hold.length) {
    const ids = hold.map((h) => h.id)
    held = (await tx.routeStep.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { holdReleaseId: release.id } })).count
    await clearAlertKeys(tx, ids.flatMap((id) => [alertKey('W2', 'step', id), alertKey('W3', 'step', id)]))
  }
  return { started: started.length, held, confirmers }
}

/** 新建发放单：发出即生效（不审批）。附件只能用发放人自己刚上传、还没被用过的 */
export async function createRelease(input: NewReleaseInput, issuerId: string) {
  const description = input.description.trim()
  if (!description) throw new FlowError('请填写说明')
  const partIds = uniq(input.partIds ?? [])
  const attachmentIds = uniq(input.attachmentIds ?? [])
  if (attachmentIds.length > MAX_ATTACHMENTS) throw new FlowError(`附件最多 ${MAX_ATTACHMENTS} 个`)
  const recipients = await resolveRecipients(input.userIds ?? [], input.groups ?? [], issuerId)

  return releaseTransaction(async (tx) => {
    const wo = await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
    if (!wo) throw new FlowError('工单不存在或已删除')
    if (partIds.length) {
      const parts = await tx.part.findMany({ where: { id: { in: partIds } }, select: { workOrderNumber: true } })
      if (parts.length !== partIds.length || parts.some((p) => p.workOrderNumber !== wo.workOrderNumber)) throw new FlowError('关联工件不存在或不属于该工单')
    }
    const release = await tx.release.create({
      data: {
        releaseNo: await nextReleaseNo(tx, new Date()),
        type: input.type,
        workOrderNumber: wo.workOrderNumber,
        partIds,
        version: input.version?.trim() || null,
        description,
        issuerId,
      },
    })
    await tx.releaseReceipt.createMany({ data: recipients.map((userId) => ({ releaseId: release.id, userId })) })
    const receipts = await tx.releaseReceipt.findMany({ where: { releaseId: release.id }, select: { id: true, userId: true } })
    await tx.todo.createMany({ data: receipts.map((r) => ({ ownerId: r.userId, action: SIGN_RELEASE, refType: 'receipt', refId: r.id })) })
    if (attachmentIds.length) {
      const bound = await tx.uploadFile.updateMany({
        where: { id: { in: attachmentIds }, uploaderId: issuerId, issueId: null, releaseId: null },
        data: { releaseId: release.id },
      })
      if (bound.count !== attachmentIds.length) throw new FlowError('附件无效或已被使用，请重新上传')
    }
    const impact: ChangeImpact = input.type === 'CHANGE' && partIds.length ? await applyChangeImpact(tx, release, partIds) : { started: 0, held: 0, confirmers: [] }
    return { id: release.id, releaseNo: release.releaseNo, recipients: receipts.length, impact }
  })
}

// ───────────── 签收 / 拒收 ─────────────

/** 锁住签收记录所在的发放单（和签收记录本身）再读 */
async function lockReceipt(tx: Tx, receiptId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM doc_release r JOIN release_receipt c ON c.releaseId = r.id WHERE c.id = ${receiptId} FOR UPDATE`
  if (!rows.length) throw new FlowError('签收记录不存在')
  return tx.releaseReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: { release: true } })
}

async function actOnReceipt(receiptId: string, userId: string, to: Extract<ReceiptStatus, 'SIGNED' | 'REJECTED'>, reason: string | null) {
  return prisma.$transaction(async (tx) => {
    const receipt = await lockReceipt(tx, receiptId)
    const verb = to === 'SIGNED' ? '签收' : '拒收'
    if (receipt.userId !== userId) throw new FlowForbidden(`只能${verb}发给自己的发放单`)
    if (receipt.release.status !== 'ACTIVE' || receipt.status === 'CANCELLED') throw new FlowError('发放单已作废，不用再签收')
    if (receipt.status !== 'PENDING') throw new FlowError(`这份发放单你已经${RECEIPT_STATUS_TEXT[receipt.status].replace('已', '')}过了，请刷新`)
    const now = new Date()
    await tx.releaseReceipt.update({ where: { id: receipt.id }, data: { status: to, reason, actedAt: now } })
    await tx.todo.updateMany({ where: { refType: 'receipt', refId: receipt.id, action: SIGN_RELEASE, status: 'OPEN' }, data: { status: 'DONE', doneAt: now } })
    await clearAlertKeys(tx, [alertKey('W5', 'receipt', receipt.id)])
    const rel = receipt.release
    if (to === 'REJECTED') {
      const who = (await loadNames({ user: [userId] })).user.get(userId) ?? userId
      const title = `【拒收】${who} 拒收了${TYPE_TEXT[rel.type]} ${rel.releaseNo}：${reason}`
      await tx.reminder.createMany({
        data: [{ userId: rel.issuerId, kind: 'RELEASE', level: 'YELLOW', title: title.length > 190 ? `${title.slice(0, 189)}…` : title, link: releaseLink(rel.id), dedupeKey: `RELEASE_REJECT:${receipt.id}` }],
        skipDuplicates: true,
      })
      return { status: to, holdsCleared: 0 }
    }
    return { status: to, holdsCleared: await autoClearHolds(tx, rel, now) }
  })
}

/**
 * 没有在加工的工序（没发"确认变更影响"待办）的设计变更：接收人全部签收 = 变更已经到了现场，自动解除"等变更"。
 * 发过确认待办的，要等确认（confirmChange）。
 */
async function autoClearHolds(tx: Tx, rel: Release, now: Date) {
  if (rel.type !== 'CHANGE' || rel.changeConfirmedAt) return 0
  const [confirmTodos, notSigned, held] = await Promise.all([
    tx.todo.count({ where: { refType: 'release', refId: rel.id, action: CONFIRM_CHANGE } }),
    tx.releaseReceipt.count({ where: { releaseId: rel.id, status: { not: 'SIGNED' } } }),
    tx.routeStep.count({ where: { holdReleaseId: rel.id } }),
  ])
  if (confirmTodos || notSigned || !held) return 0
  await tx.release.update({ where: { id: rel.id }, data: { changeConfirmedAt: now, changeConfirmedBy: null, changeConfirmNote: '接收人全部签收，自动解除等变更' } })
  return clearHolds(tx, rel.id, now)
}

export const signReceipt = (receiptId: string, userId: string) => actOnReceipt(receiptId, userId, 'SIGNED', null)

export function rejectReceipt(receiptId: string, userId: string, reason: string) {
  const r = reason.trim()
  if (!r) throw new FlowError('请填写拒收原因')
  return actOnReceipt(receiptId, userId, 'REJECTED', r)
}

// ───────────── 作废 / 确认变更影响 ─────────────

/** 作废（发错了）：发放人或管理员。未签收的签收记录、签收待办、确认待办一并作废，"等变更"解除 */
export async function voidRelease(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const rel = await lockRelease(tx, id)
    if (!actor.isAdmin && rel.issuerId !== actor.userId) throw new FlowForbidden('只有发放人或管理员可以作废')
    if (rel.status === 'VOID') throw new FlowError('发放单已经作废了')
    const now = new Date()
    const pending = await tx.releaseReceipt.findMany({ where: { releaseId: id, status: 'PENDING' }, select: { id: true } })
    const pendingIds = pending.map((p) => p.id)
    await tx.releaseReceipt.updateMany({ where: { id: { in: pendingIds } }, data: { status: 'CANCELLED', actedAt: now } })
    await tx.todo.updateMany({
      where: { status: 'OPEN', OR: [{ refType: 'receipt', refId: { in: pendingIds } }, { refType: 'release', refId: id }] },
      data: { status: 'CANCELLED', doneAt: now },
    })
    await clearAlertKeys(tx, pendingIds.map((r) => alertKey('W5', 'receipt', r)))
    const holdsCleared = await clearHolds(tx, id, now)
    await tx.release.update({ where: { id }, data: { status: 'VOID' } })
    return { cancelled: pendingIds.length, holdsCleared }
  })
}

/**
 * 确认变更影响：收到"确认变更影响"待办的人（生产经理、外协专员）、发放人、管理员。
 * 一人确认即可：其余人的确认待办一并关闭，"等变更"解除。note 写处理意见（如"已通知外协厂按新图返修"），可空。
 */
export async function confirmChange(id: string, actor: Actor, note: string | null) {
  return prisma.$transaction(async (tx) => {
    const rel = await lockRelease(tx, id)
    if (rel.type !== 'CHANGE') throw new FlowError('只有设计变更需要确认变更影响')
    if (rel.status !== 'ACTIVE') throw new FlowError('发放单已作废')
    if (rel.changeConfirmedAt) throw new FlowError('变更影响已经确认过了，请刷新')
    const mine = await tx.todo.findFirst({ where: { refType: 'release', refId: id, action: CONFIRM_CHANGE, status: 'OPEN', ownerId: actor.userId }, select: { id: true } })
    if (!actor.isAdmin && rel.issuerId !== actor.userId && !mine) throw new FlowForbidden('只有收到"确认变更影响"待办的人（生产经理、外协专员）、发放人或管理员可以确认')
    const now = new Date()
    await tx.todo.updateMany({ where: { refType: 'release', refId: id, action: CONFIRM_CHANGE, status: 'OPEN' }, data: { status: 'DONE', doneAt: now } })
    await tx.release.update({ where: { id }, data: { changeConfirmedAt: now, changeConfirmedBy: actor.userId, changeConfirmNote: note?.trim() || null } })
    return { holdsCleared: await clearHolds(tx, id, now) }
  })
}

// ───────────── 查询 ─────────────

type Counts = Record<ReceiptStatus, number>
function countReceipts(receipts: { status: ReceiptStatus }[]): Counts {
  const c: Counts = { PENDING: 0, SIGNED: 0, REJECTED: 0, CANCELLED: 0 }
  for (const r of receipts) c[r.status]++
  return c
}

/** 列表上的状态文字：已作废 / 有拒收 / 签收中 / 已全部签收 */
function progressText(status: Release['status'], c: Counts) {
  if (status === 'VOID') return '已作废'
  if (c.REJECTED) return '有拒收'
  if (c.PENDING) return '签收中'
  return '已全部签收'
}

async function partNames(partIds: string[]) {
  if (!partIds.length) return new Map<string, { name: string; drawingNo: string | null }>()
  const parts = await prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true, drawingNo: true } })
  return new Map(parts.map((p) => [p.id, { name: p.name, drawingNo: p.drawingNo }]))
}

export interface ReleaseFilter {
  workOrderNumber?: string
  type?: ReleaseType
  /** PENDING = 有人未签收；REJECTED = 有人拒收；VOID = 已作废 */
  progress?: 'PENDING' | 'REJECTED' | 'VOID'
  /** issued = 我发出的；received = 发给我的 */
  mine?: 'issued' | 'received'
  /** 可见工单（undefined = 全部）。发给我的发放单不受可见范围限制 */
  visibleWorkOrders?: string[]
}

export async function listReleases(filter: ReleaseFilter, viewerId: string) {
  const and: Prisma.ReleaseWhereInput[] = []
  if (filter.workOrderNumber) and.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.type) and.push({ type: filter.type })
  if (filter.progress === 'VOID') and.push({ status: 'VOID' })
  if (filter.progress === 'PENDING') and.push({ status: 'ACTIVE', receipts: { some: { status: 'PENDING' } } })
  if (filter.progress === 'REJECTED') and.push({ status: 'ACTIVE', receipts: { some: { status: 'REJECTED' } } })
  if (filter.mine === 'issued') and.push({ issuerId: viewerId })
  if (filter.mine === 'received') and.push({ receipts: { some: { userId: viewerId } } })
  if (filter.visibleWorkOrders) and.push({ OR: [{ workOrderNumber: { in: filter.visibleWorkOrders } }, { receipts: { some: { userId: viewerId } } }] })
  const rows = await prisma.release.findMany({
    where: { AND: and },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { receipts: { select: { status: true, userId: true } } },
  })
  const parts = await partNames(rows.flatMap((r) => partIdsOf(r.partIds)))
  const names = await loadNames({ user: rows.map((r) => r.issuerId) })
  const held = rows.length
    ? await prisma.routeStep.groupBy({ by: ['holdReleaseId'], where: { holdReleaseId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
    : []
  const heldOf = new Map(held.map((h) => [h.holdReleaseId!, h._count._all]))
  return rows.map(({ receipts, ...r }) => {
    const counts = countReceipts(receipts)
    const mine = receipts.find((x) => x.userId === viewerId)
    return {
      ...r,
      partIds: partIdsOf(r.partIds),
      typeText: TYPE_TEXT[r.type],
      parts: partIdsOf(r.partIds).map((id) => parts.get(id)?.name ?? '（已删除的工件）'),
      issuerName: names.user.get(r.issuerId) ?? r.issuerId,
      counts,
      total: receipts.length,
      progressText: progressText(r.status, counts),
      myStatus: mine?.status ?? null,
      heldSteps: heldOf.get(r.id) ?? 0,
    }
  })
}

/** 详情可见：能看该工单，或者是接收人（发给我的，就算不是我负责的工单也要能看、能签） */
export async function assertCanViewRelease(id: string, viewerId: string, canSeeWorkOrder: (wo: string) => boolean) {
  const rel = await prisma.release.findUnique({ where: { id }, select: { workOrderNumber: true, receipts: { where: { userId: viewerId }, select: { id: true } } } })
  if (!rel) throw new FlowError('发放单不存在')
  if (!canSeeWorkOrder(rel.workOrderNumber) && !rel.receipts.length) throw new FlowForbidden('无权查看该工单的数据')
}

/** 签收记录所属发放单的 ID（接口层做可见性检查用）；不存在时 null */
export async function releaseIdOfReceipt(receiptId: string) {
  return (await prisma.releaseReceipt.findUnique({ where: { id: receiptId }, select: { releaseId: true } }))?.releaseId ?? null
}

/** 发放单详情：内容、附件、每个接收人的签收状态、设计变更影响的工序，以及当前用户能做的操作 */
export async function getRelease(id: string, viewer: Actor) {
  const rel = await prisma.release.findUnique({ where: { id }, include: { receipts: { orderBy: { createdAt: 'asc' } } } })
  if (!rel) throw new FlowError('发放单不存在')
  const partIds = partIdsOf(rel.partIds)
  const [parts, attachments, confirmTodos, wo] = await Promise.all([
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, include: { steps: { orderBy: { seq: 'asc' } } } }) : [],
    prisma.uploadFile.findMany({ where: { releaseId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, mime: true, size: true } }),
    prisma.todo.findMany({ where: { refType: 'release', refId: id, action: CONFIRM_CHANGE }, orderBy: { createdAt: 'asc' } }),
    prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber: rel.workOrderNumber }, select: { projectName: true, customerName: true } }),
  ])
  const steps = parts.flatMap((p) => p.steps)
  const userIds = [rel.issuerId, rel.changeConfirmedBy, ...rel.receipts.map((r) => r.userId), ...confirmTodos.map((t) => t.ownerId)]
  const [names, deptOf] = await Promise.all([
    loadNames({ user: userIds, process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId) }),
    userDepartmentNames(rel.receipts.map((r) => r.userId)),
  ])
  const userName = (uid: string | null) => (uid ? (names.user.get(uid) ?? uid) : null)
  const mine = rel.receipts.find((r) => r.userId === viewer.userId) ?? null
  const active = rel.status === 'ACTIVE'
  const heldSteps = steps.filter((s) => s.holdReleaseId === rel.id).length
  const openConfirm = confirmTodos.filter((t) => t.status === 'OPEN')
  const isIssuer = rel.issuerId === viewer.userId
  const needsConfirm = rel.type === 'CHANGE' && active && !rel.changeConfirmedAt && (heldSteps > 0 || openConfirm.length > 0)
  const counts = countReceipts(rel.receipts)
  return {
    id: rel.id,
    releaseNo: rel.releaseNo,
    type: rel.type,
    typeText: TYPE_TEXT[rel.type],
    workOrderNumber: rel.workOrderNumber,
    projectName: wo?.projectName ?? null,
    customerName: wo?.customerName ?? null,
    version: rel.version,
    description: rel.description,
    status: rel.status,
    issuerId: rel.issuerId,
    issuerName: userName(rel.issuerId),
    createdAt: rel.createdAt,
    counts,
    progressText: progressText(rel.status, counts),
    attachments: attachments.map((a) => ({ ...a, url: `/api/files/${a.id}` })),
    receipts: rel.receipts.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: userName(r.userId),
      department: deptOf.get(r.userId) ?? null,
      status: r.status,
      statusText: RECEIPT_STATUS_TEXT[r.status],
      reason: r.reason,
      actedAt: r.actedAt,
    })),
    myReceipt: mine ? { id: mine.id, status: mine.status, reason: mine.reason, actedAt: mine.actedAt } : null,
    parts: parts.map((p) => ({
      id: p.id,
      name: p.name,
      drawingNo: p.drawingNo,
      steps: p.steps.map((s) => ({
        id: s.id,
        seq: s.seq,
        processName: names.process.get(s.processId) ?? s.processId,
        supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
        mode: s.mode,
        status: s.status,
        statusText: STEP_STATUS_TEXT[s.status],
        /** 被这张变更单标了"等变更" */
        held: s.holdReleaseId === rel.id,
        /** 被另一张更新的变更单标了"等变更" */
        heldByOther: !!s.holdReleaseId && s.holdReleaseId !== rel.id,
      })),
    })),
    missingParts: partIds.length - parts.length,
    change:
      rel.type === 'CHANGE'
        ? {
            heldSteps,
            confirmers: confirmTodos.map((t) => ({ userId: t.ownerId, userName: userName(t.ownerId), status: t.status })),
            confirmedAt: rel.changeConfirmedAt,
            confirmedByName: userName(rel.changeConfirmedBy),
            confirmNote: rel.changeConfirmNote,
            needsConfirm,
          }
        : null,
    permissions: {
      sign: active && mine?.status === 'PENDING',
      void: active && (viewer.isAdmin || isIssuer),
      confirmChange: needsConfirm && (viewer.isAdmin || isIssuer || openConfirm.some((t) => t.ownerId === viewer.userId)),
    },
  }
}

/** 我的签收（手机）：pending = 待签收（发放单有效）；done = 最近处理过的 50 条 */
export async function listMyReceipts(userId: string, tab: 'pending' | 'done') {
  const rows = await prisma.releaseReceipt.findMany({
    where: tab === 'pending' ? { userId, status: 'PENDING', release: { status: 'ACTIVE' } } : { userId, status: { not: 'PENDING' } },
    orderBy: tab === 'pending' ? { createdAt: 'asc' } : { actedAt: 'desc' },
    take: tab === 'pending' ? 200 : 50,
    include: { release: true },
  })
  const parts = await partNames(rows.flatMap((r) => partIdsOf(r.release.partIds)))
  const names = await loadNames({ user: rows.map((r) => r.release.issuerId) })
  return rows.map((r) => ({
    receiptId: r.id,
    status: r.status,
    statusText: RECEIPT_STATUS_TEXT[r.status],
    reason: r.reason,
    actedAt: r.actedAt,
    releaseId: r.release.id,
    releaseNo: r.release.releaseNo,
    type: r.release.type,
    typeText: TYPE_TEXT[r.release.type],
    workOrderNumber: r.release.workOrderNumber,
    version: r.release.version,
    description: r.release.description,
    parts: partIdsOf(r.release.partIds).map((id) => parts.get(id)?.name ?? '（已删除的工件）'),
    issuerName: names.user.get(r.release.issuerId) ?? r.release.issuerId,
    createdAt: r.createdAt,
  }))
}

/** 我的待办里发放相关的两类（签收、确认变更影响）：附上发放单摘要，页面直接展示 */
export async function describeReleaseTodos(todos: { action: string; refType: string; refId: string }[]) {
  const receiptIds = todos.filter((t) => t.refType === 'receipt').map((t) => t.refId)
  const releaseIds = todos.filter((t) => t.refType === 'release').map((t) => t.refId)
  const [receipts, releases] = await Promise.all([
    receiptIds.length ? prisma.releaseReceipt.findMany({ where: { id: { in: receiptIds } }, include: { release: true } }) : [],
    releaseIds.length ? prisma.release.findMany({ where: { id: { in: releaseIds } } }) : [],
  ])
  const all = [...receipts.map((r) => r.release), ...releases]
  const parts = await partNames(all.flatMap((r) => partIdsOf(r.partIds)))
  const summary = (r: Release) => ({
    id: r.id,
    releaseNo: r.releaseNo,
    type: r.type,
    typeText: TYPE_TEXT[r.type],
    workOrderNumber: r.workOrderNumber,
    version: r.version,
    parts: partIdsOf(r.partIds).map((id) => parts.get(id)?.name ?? '（已删除的工件）'),
  })
  return {
    byReceipt: new Map(receipts.map((r) => [r.id, summary(r.release)])),
    byRelease: new Map(releases.map((r) => [r.id, summary(r)])),
  }
}
