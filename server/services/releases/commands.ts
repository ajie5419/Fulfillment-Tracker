import { Prisma, type ReceiptStatus, type Release } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey } from '../alerts/rules'
import { FlowError, FlowForbidden } from '../flow/errors'
import { loadNames } from '../flow/names'
import { assertReleasable, DrawingTaskNotFoundError, lockTask, settleTask } from '../drawings/drawings'
import { lockMaterialChangeParts, markRevisingByChange, markRevisingByVoid } from '../process/process'
import { lockParts, refreshPartReady } from '../purchases/purchases'
import { XLSX_MIME, applyTechBom, type TechBomResult } from '../bom/excel'
import { CONFIRM_CHANGE, MAX_ATTACHMENTS, PRODUCTION_DEPT, RECEIPT_STATUS_TEXT, SIGN_RELEASE, TYPE_TEXT, partIdsOf, releaseLink, splitAffectedSteps } from './constants'
import type { Actor, NewReleaseInput, ChangeImpact } from './types'
import { uniq } from './calculation'
import { resolveRecipients } from './recipients'
import { releaseTransaction, nextReleaseNo } from './transaction'

type Tx = Prisma.TransactionClient

/** 先锁发放单行再读（锁是事务里第一条语句，之后的普通读看到的是加锁后的最新数据） */
async function lockRelease(tx: Tx, id: string): Promise<Release> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM doc_release WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('发放单不存在')
  return tx.release.findUniqueOrThrow({ where: { id } })
}

/**
 * 解除这张发放单打的"等变更"（被更新的变更单覆盖过的不动），记下解除时间供 W2 重新计时。
 * sync：解除的工序里有第一道的，按统一口径重新评估"可以开工"待办（齐了就补发）；作废时还要把部分工序还给更早的变更单，由调用方最后再评估。
 */
async function clearHolds(tx: Tx, releaseId: string, now: Date, sync = true) {
  // 锁顺序：先锁工件再改工序（与改工序 / refreshPartReady 一致，见 purchases.refreshPartReady），避免死锁
  const pre = await tx.routeStep.findMany({ where: { holdReleaseId: releaseId }, select: { partId: true } })
  if (!pre.length) return { count: 0, stepIds: [] as string[] }
  await lockParts(tx, pre.map((s) => s.partId))
  const ids = (await tx.routeStep.findMany({ where: { holdReleaseId: releaseId }, select: { id: true } })).map((s) => s.id)
  if (!ids.length) return { count: 0, stepIds: ids }
  const r = await tx.routeStep.updateMany({ where: { id: { in: ids }, holdReleaseId: releaseId }, data: { holdReleaseId: null, holdClearedAt: now } })
  if (sync) await syncFirstStepReady(tx, ids, true)
  return { count: r.count, stepIds: ids }
}

/**
 * "等变更"变了的工序里是第一道的：重新评估工件的"可以开工"待办（flow/readiness.ts firstStepTodoReady，与生产调度同一条规则）。
 * 打上"等变更" → 作废没处理的待办（notify = false）；解除 → 物料图纸都齐了就补发（notify = true）。
 */
async function syncFirstStepReady(tx: Tx, stepIds: string[], notify: boolean) {
  if (!stepIds.length) return
  const changed = new Set(stepIds)
  const parts = [...new Set((await tx.routeStep.findMany({ where: { id: { in: stepIds } }, select: { partId: true } })).map((s) => s.partId))].sort()
  for (const partId of parts) {
    const first = await tx.routeStep.findFirst({ where: { partId }, orderBy: { seq: 'asc' }, select: { id: true } })
    if (first && changed.has(first.id)) await refreshPartReady(tx, partId, notify)
  }
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
    // 锁顺序：先锁工件再改工序（见 purchases.refreshPartReady），避免和改工序互相等锁
    await lockParts(tx, partIds)
    held = (await tx.routeStep.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { holdReleaseId: release.id } })).count
    await clearAlertKeys(tx, ids.flatMap((id) => [alertKey('W2', 'step', id), alertKey('W3', 'step', id)]))
    // 第一道在"等变更"：不能开工，作废它的"可以开工"待办（生产调度里显示卡住·等变更）
    await syncFirstStepReady(tx, ids, false)
  }
  return { started: started.length, held, confirmers }
}

/** 工件页"只看未排工序"的地址 */
export const unroutedPartsLink = (workOrderNumber: string) => `/parts?wo=${encodeURIComponent(workOrderNumber)}&noRoute=1`

/**
 * 图纸附 BOM 发放后，BOM 里还没有工序链的工件：提醒生产经理（生产部负责人）排工序（10-26，借鉴 ERPNext 生产计划
 * "每个子件都要定自制 / 外协"）。没有工序的工件不会产生待办和预警，等于在系统里"隐身"。返回未排工序的工件数。
 * 同一发放单每人只一条（dedupeKey），跳到工件页并只看未排工序的工件。
 */
async function notifyUnrouted(tx: Prisma.TransactionClient, release: Pick<Release, 'id' | 'releaseNo' | 'workOrderNumber'>, partIds: string[]) {
  const unrouted = await tx.part.count({ where: { id: { in: partIds }, steps: { none: {} } } })
  if (!unrouted) return { unrouted: 0, notified: false }
  const heads = await tx.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: PRODUCTION_DEPT }, select: { userId: true } })
  // 只算在职、未停用的负责人：设置里的角色不会随 QMS 停用账号自动删掉
  const candidates = uniq(heads.map((h) => h.userId))
  const users = candidates.length
    ? (await tx.qmsUser.findMany({ where: { id: { in: candidates }, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })).map((u) => u.id)
    : []
  // 没设生产部负责人时不提醒，也不能告诉发放人"已提醒"：返回 notified=false，前端改说"请到设置→人员角色指定"
  if (users.length) {
    const title = `【待排工序】图纸发放 ${release.releaseNo} 有 ${unrouted} 个工件还没有工序链，请排工序（${release.workOrderNumber}）`
    await tx.reminder.createMany({
      data: users.map((userId) => ({ userId, kind: 'RELEASE', level: 'REMIND' as const, title, link: unroutedPartsLink(release.workOrderNumber), dedupeKey: `RELEASE_ROUTE:${release.id}:${userId}` })),
      skipDuplicates: true,
    })
  }
  return { unrouted, notified: users.length > 0 }
}

/** 新建发放单：发出即生效（不审批）。附件只能用发放人自己刚上传、还没被用过的 */
export async function createRelease(input: NewReleaseInput, issuerId: string) {
  const description = input.description.trim()
  if (!description) throw new FlowError('请填写说明')
  const partIds = uniq(input.partIds ?? [])
  const attachmentIds = uniq(input.attachmentIds ?? [])
  if (attachmentIds.length > MAX_ATTACHMENTS) throw new FlowError(`附件最多 ${MAX_ATTACHMENTS} 个`)
  const recipients = await resolveRecipients(input.userIds ?? [], input.groups ?? [], issuerId)

  const taskId = input.drawingTaskId || null
  const bomInput = input.bom ?? null
  if (bomInput && input.type !== 'DRAWING') throw new FlowError('只有图纸发放单可以附 BOM 表')
  return releaseTransaction(async (tx) => {
    let bom: TechBomResult | null = null
    if (bomInput) {
      // 先锁工单行（工单还没有工件时，锁工件行锁不住任何东西），再锁该工单全部工件、按图号建工件
      await tx.$queryRaw`SELECT workOrderNumber FROM qms_work_order WHERE workOrderNumber = ${input.workOrderNumber} FOR UPDATE`
      const exists = await tx.qmsWorkOrder.count({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false } })
      if (!exists) throw new FlowError('工单不存在或已删除')
      bom = await applyTechBom(tx, input.workOrderNumber, bomInput.rows, { createdBy: issuerId })
    }
    if (input.type === 'CHANGE') await lockMaterialChangeParts(tx, partIds, taskId)
    // 设计任务：先锁它的工件和任务行（与设计任务、采购同一加锁顺序）
    const task = taskId ? await lockTask(tx, taskId) : null
    const wo = await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
    if (!wo) throw new FlowError('工单不存在或已删除')
    if (task) assertReleasable(task, wo.workOrderNumber, input.type)
    if (partIds.length) {
      const parts = await tx.part.findMany({ where: { id: { in: partIds } }, select: { workOrderNumber: true } })
      if (parts.length !== partIds.length || parts.some((p) => p.workOrderNumber !== wo.workOrderNumber)) throw new FlowError('关联工件不存在或不属于该工单')
    }
    const bomPartIds = bom ? [...bom.created, ...bom.matched] : []
    const release = await tx.release.create({
      data: {
        releaseNo: await nextReleaseNo(tx, new Date()),
        type: input.type,
        workOrderNumber: wo.workOrderNumber,
        partIds: uniq([...partIds, ...bomPartIds]),
        version: input.version?.trim() || null,
        description,
        issuerId,
        drawingTaskId: task?.id ?? null,
        bomFileId: bomInput?.fileId ?? null,
      },
    })
    await tx.releaseReceipt.createMany({ data: recipients.map((userId) => ({ releaseId: release.id, userId })) })
    const receipts = await tx.releaseReceipt.findMany({ where: { releaseId: release.id }, select: { id: true, userId: true } })
    await tx.todo.createMany({ data: receipts.map((r) => ({ ownerId: r.userId, action: SIGN_RELEASE, refType: 'receipt', refId: r.id })) })
    if (attachmentIds.length) {
      const bound = await tx.uploadFile.updateMany({
        // BOM 表（.xlsx）只能走 bomFileId，不能当普通附件
        where: { id: { in: attachmentIds }, uploaderId: issuerId, issueId: null, releaseId: null, mime: { not: XLSX_MIME } },
        data: { releaseId: release.id },
      })
      if (bound.count !== attachmentIds.length) throw new FlowError('附件无效或已被使用，请重新上传')
    }
    if (bomInput) {
      const bound = await tx.uploadFile.updateMany({
        where: { id: bomInput.fileId, uploaderId: issuerId, issueId: null, releaseId: null, mime: XLSX_MIME },
        data: { releaseId: release.id },
      })
      if (bound.count !== 1) throw new FlowError('BOM 表无效或已被使用，请重新选择')
    }
    if (bom?.purchasePlanId) await tx.purchasePlan.update({ where: { id: bom.purchasePlanId }, data: { title: `BOM 外购件 ${release.releaseNo}` } })
    // 从设计任务发放：BOM 里的工件都挂到这个设计任务（原来挂着的不动）
    if (task && bomPartIds.length) await tx.drawingTaskPart.createMany({ data: bomPartIds.map((partId) => ({ taskId: task.id, partId })), skipDuplicates: true })
    const impact: ChangeImpact = input.type === 'CHANGE' && partIds.length ? await applyChangeImpact(tx, release, partIds) : { started: 0, held: 0, confirmers: [] }
    // 工艺模块（10-27）：设计变更涉及已下发的料单 → 自动改"修改中"，提醒工艺部负责人
    const material = input.type === 'CHANGE' ? await markRevisingByChange(tx, release, partIds, task?.id ?? null) : { revising: 0, notified: false }
    const drawing = task ? await settleTask(tx, { status: task.status, partIds: task.parts.map((p) => p.partId) }, task.id) : null
    const { unrouted, notified } = bomPartIds.length ? await notifyUnrouted(tx, release, bomPartIds) : { unrouted: 0, notified: false }
    const bomSummary = bom ? { created: bom.created.length, matched: bom.matched.length, revisionFilled: bom.revisionFilled, skipped: bom.skipped, unrouted, unroutedNotified: notified, ...(bom.purchasePlanId ? { purchasePlanId: bom.purchasePlanId, purchasePlanItems: bom.purchasePlanItems } : {}) } : null
    return { id: release.id, releaseNo: release.releaseNo, recipients: receipts.length, impact, drawing, bom: bomSummary, material }
  }, !!taskId || !!bomInput)
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
      const who = (await loadNames({ user: [userId] }, tx)).user.get(userId) ?? userId
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
  await clearAlertKeys(tx, [alertKey('W5', 'release', rel.id)])
  return (await clearHolds(tx, rel.id, now)).count
}

export const signReceipt = (receiptId: string, userId: string) => actOnReceipt(receiptId, userId, 'SIGNED', null)

export function rejectReceipt(receiptId: string, userId: string, reason: string) {
  const r = reason.trim()
  if (!r) throw new FlowError('请填写拒收原因')
  return actOnReceipt(receiptId, userId, 'REJECTED', r)
}

// ───────────── 作废 / 确认变更影响 ─────────────

/**
 * 作废变更单时，它标的"等变更"工序如果也在更早一张仍有效、未确认的变更单范围里，就还给那一张（最新的那张），
 * 免得旧变更还没确认、工序却恢复了 W2/W3 计时。返回 发放单 ID → 工序 ID。
 */
async function olderHolds(tx: Tx, rel: Release) {
  const out = new Map<string, string[]>()
  if (rel.type !== 'CHANGE') return out
  const steps = await tx.routeStep.findMany({ where: { holdReleaseId: rel.id, status: 'PENDING' }, select: { id: true, partId: true } })
  if (!steps.length) return out
  const older = await tx.release.findMany({
    where: { id: { not: rel.id }, type: 'CHANGE', status: 'ACTIVE', changeConfirmedAt: null, workOrderNumber: rel.workOrderNumber },
    orderBy: { createdAt: 'desc' },
    select: { id: true, partIds: true },
  })
  for (const s of steps) {
    const to = older.find((o) => partIdsOf(o.partIds).includes(s.partId))
    if (to) out.set(to.id, [...(out.get(to.id) ?? []), s.id])
  }
  if (!out.size) return out
  // 锁住要还回去的发放单并复核仍有效、未确认（防止同时有人确认 / 作废它）
  const ids = [...out.keys()]
  const live = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM doc_release WHERE id IN (${Prisma.join(ids)}) AND status = 'ACTIVE' AND changeConfirmedAt IS NULL FOR UPDATE`
  const ok = new Set(live.map((r) => r.id))
  for (const id of ids) if (!ok.has(id)) out.delete(id)
  return out
}

/** 作废（发错了）：发放人或管理员。未签收的签收记录、签收待办、确认待办一并作废，"等变更"解除（更早的有效变更单覆盖的工序还给它） */
export async function voidRelease(id: string, actor: Actor) {
  // 关联了设计任务的：先锁任务（及其工件）再锁发放单，作废后任务回到"设计完成"，重新评估"可以开工"
  const taskId = (await prisma.release.findUnique({ where: { id }, select: { drawingTaskId: true } }))?.drawingTaskId ?? null
  return prisma.$transaction(async (tx) => {
    const task = taskId ? await lockTask(tx, taskId).catch((error: unknown) => {
      if (error instanceof DrawingTaskNotFoundError) return null
      throw error
    }) : null
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
    await clearAlertKeys(tx, [...pendingIds.map((r) => alertKey('W5', 'receipt', r)), alertKey('W5', 'release', id)])
    const restoreTo = await olderHolds(tx, rel)
    const cleared = await clearHolds(tx, id, now, false)
    const holdsCleared = cleared.count
    const restored = new Set<string>()
    for (const [releaseId, stepIds] of restoreTo) {
      await tx.routeStep.updateMany({ where: { id: { in: stepIds }, holdReleaseId: null, status: 'PENDING' }, data: { holdReleaseId: releaseId } })
      stepIds.forEach((x) => restored.add(x))
    }
    await tx.release.update({ where: { id }, data: { status: 'VOID' } })
    if (task) await markRevisingByVoid(tx, task, rel, actor.userId, now)
    if (task) await settleTask(tx, { status: task.status, partIds: task.parts.map((p) => p.partId) }, task.id)
    // 先回退文档、重算设计，再评估真正解除的第一道，避免按作废前的前提误发待办。
    await syncFirstStepReady(tx, cleared.stepIds.filter((x) => !restored.has(x)), true)
    return { cancelled: pendingIds.length, holdsCleared }
  }, taskId ? { isolationLevel: 'ReadCommitted' } : undefined)
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
    await clearAlertKeys(tx, [alertKey('W5', 'release', id)])
    return { holdsCleared: (await clearHolds(tx, id, now)).count }
  })
}
