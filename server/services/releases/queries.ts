import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError, FlowForbidden } from '../flow/errors'
import { loadNames } from '../flow/names'
import { CONFIRM_CHANGE, partIdsOf } from './constants'
import type { Actor, ReleaseFilter } from './types'
import { releaseScope, progressWhere } from './calculation'
import { partNames, loadReleaseView } from './loaders'
import { projectRelease, projectReleaseRows, projectMyReceipts, projectReleaseTodos } from './projection'

/**
 * 发放签收页顶部统计卡（前端改版第二轮）：按工单、类型、我发出的 / 发给我的、可见范围（与列表同一范围，不受签收进度筛选影响），
 * 用 count，不受列表 200 条截断影响。每个数字与列表"签收进度"筛选同一口径。
 */
export async function releaseStats(filter: Omit<ReleaseFilter, 'progress'>, viewerId: string) {
  const scope = releaseScope(filter, viewerId)
  const count = (w?: Prisma.ReleaseWhereInput) => prisma.release.count({ where: { AND: w ? [...scope, w] : scope } })
  const [all, pending, rejected, minePending] = await Promise.all([
    count(),
    count(progressWhere('PENDING', viewerId)),
    count(progressWhere('REJECTED', viewerId)),
    count(progressWhere('MINE_PENDING', viewerId)),
  ])
  return { all, pending, rejected, minePending }
}

export async function listReleases(filter: ReleaseFilter, viewerId: string) {
  const and = releaseScope(filter, viewerId)
  if (filter.progress) and.push(progressWhere(filter.progress, viewerId))
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
  return projectReleaseRows(rows, parts, names, held, viewerId)
}

/**
 * 和这张发放单直接相关的人：发放人、接收人、收到过"确认变更影响"待办的人。
 * 他们不受工单范围限制（发给我的 / 我发的 / 要我确认的，就算工单后来改派了也要能看、能处理、能读附件）。
 */
export async function isReleaseParty(id: string, userId: string) {
  const [rel, receipt, todo] = await Promise.all([
    prisma.release.findUnique({ where: { id }, select: { issuerId: true } }),
    prisma.releaseReceipt.findFirst({ where: { releaseId: id, userId }, select: { id: true } }),
    prisma.todo.findFirst({ where: { refType: 'release', refId: id, action: CONFIRM_CHANGE, ownerId: userId }, select: { id: true } }),
  ])
  return rel?.issuerId === userId || !!receipt || !!todo
}

/** 详情可见：能看该工单，或者是发放人 / 接收人 / 确认人（见 isReleaseParty） */
export async function assertCanViewRelease(id: string, viewerId: string, canSeeWorkOrder: (wo: string) => boolean) {
  const rel = await prisma.release.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (!rel) throw new FlowError('发放单不存在')
  if (!canSeeWorkOrder(rel.workOrderNumber) && !(await isReleaseParty(id, viewerId))) throw new FlowForbidden('无权查看该工单的数据')
}

/** 发放单详情：内容、附件、每个接收人的签收状态、设计变更影响的工序，以及当前用户能做的操作 */
export async function getRelease(id: string, viewer: Actor) {
  const sources = await loadReleaseView(id)
  return projectRelease(sources, viewer)
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
  return projectMyReceipts(rows, parts, names)
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
  return projectReleaseTodos(receipts, releases, parts)
}
