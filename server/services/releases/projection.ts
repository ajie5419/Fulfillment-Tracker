/** 发放签收的展示投影；只装配 DTO，不读写数据库。 */
import type { Prisma, Release } from '@prisma/client'
import type { NameMaps } from '../flow/names'
import { TYPE_TEXT, RECEIPT_STATUS_TEXT, STEP_STATUS_TEXT, partIdsOf } from './constants'
import { countReceipts, progressText } from './calculation'
import type { Actor } from './types'
import type { loadReleaseView, partNames } from './loaders'

type Parts = Awaited<ReturnType<typeof partNames>>
type Receipt = Prisma.ReleaseReceiptGetPayload<{ include: { release: true } }>
type ReleaseRow = Prisma.ReleaseGetPayload<{ include: { receipts: { select: { status: true; userId: true } } } }>

export function projectRelease({ rel, partIds, parts, attachments, confirmTodos, wo, steps, names, deptOf }: Awaited<ReturnType<typeof loadReleaseView>>, viewer: Actor) {
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
    drawingTaskId: rel.drawingTaskId,
    issuerId: rel.issuerId,
    issuerName: userName(rel.issuerId),
    createdAt: rel.createdAt,
    counts,
    progressText: progressText(rel.status, counts),
    attachments: attachments.filter((a) => a.id !== rel.bomFileId).map((a) => ({ ...a, url: `/api/files/${a.id}` })),
    /** 附的 BOM 表（Excel，下载）；发放时已按它建好 parts 里的工件 */
    bomFile: (() => {
      const f = rel.bomFileId ? attachments.find((a) => a.id === rel.bomFileId) : undefined
      return f ? { ...f, url: `/api/files/${f.id}` } : null
    })(),
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
      revision: p.revision,
      quantity: p.quantity,
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

export function projectReleaseRows(rows: ReleaseRow[], parts: Parts, names: NameMaps, held: { holdReleaseId: string | null; _count: { _all: number } }[], viewerId: string) {
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

export function projectMyReceipts(rows: Receipt[], parts: Parts, names: NameMaps) {
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

export function projectReleaseTodos(receipts: Receipt[], releases: Release[], parts: Parts) {
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
