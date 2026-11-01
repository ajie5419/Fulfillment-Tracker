import { prisma } from '../../../utils/prisma'
import { loadNames } from '../../flow/names'
import { CONFIRM_CHANGE, TYPE_TEXT } from '../../releases/constants'
import { alertKey, type Thresholds, durationText, elapsedExcludingOffDays, levelByElapsed } from '../rules'
import type { Target } from '../types'

/**
 * W5 发放未签收（R9）：有效发放单上待签收的签收记录，从发放起计时（不含停工日）。
 * 责任人是接收人；黄色起加通知发放人（以及按升级阶梯：接收人所在部门负责人、工单项目经理），红色再加项目部负责人、分管领导。
 * 设计变更的"确认变更影响"同样按 W5 计时（见 collectW5Changes），保证"等变更"不会无声地一直挂着。
 */
export async function collectW5(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const [receipts, changes] = await Promise.all([collectW5Receipts(now, t, offDays), collectW5Changes(now, t, offDays)])
  return [...receipts, ...changes]
}

async function collectW5Receipts(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const rows = await prisma.releaseReceipt.findMany({ where: { status: 'PENDING', release: { status: 'ACTIVE' } }, include: { release: true } })
  if (!rows.length) return []
  const names = await loadNames({ user: rows.map((r) => r.userId) })
  return rows.map((r) => {
    const rel = r.release
    const elapsed = elapsedExcludingOffDays(r.createdAt, now, offDays)
    return {
      rule: 'W5',
      refType: 'receipt',
      refId: r.id,
      key: alertKey('W5', 'receipt', r.id),
      workOrderNumber: rel.workOrderNumber,
      ownerIds: [r.userId],
      watcherIds: [rel.issuerId],
      startAt: r.createdAt,
      level: levelByElapsed(elapsed, t.W5),
      subject: `${TYPE_TEXT[rel.type]} ${rel.releaseNo}${rel.version ? `（${rel.version}）` : ''}`,
      summary: `已发放 ${durationText(elapsed)}，${names.user.get(r.userId) ?? r.userId}仍未签收`,
      meta: { releaseId: rel.id },
    }
  })
}

/**
 * W5 变更影响未确认：有效、未确认的设计变更，只要
 * - 还有打开的"确认变更影响"待办：责任人是待办人（生产经理、外协专员），从最早发出确认待办起计时；或
 * - 还有"等变更"的工序、却已没有待签收的人（有人拒收，自动解除走不通）：责任人是发放人，从发放起计时。
 * 两种都是黄色起加通知发放人。确认 / 作废后对象消失，告警解除。
 */
async function collectW5Changes(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const rels = await prisma.release.findMany({ where: { type: 'CHANGE', status: 'ACTIVE', changeConfirmedAt: null } })
  if (!rels.length) return []
  const ids = rels.map((r) => r.id)
  const [todos, held, pending] = await Promise.all([
    prisma.todo.findMany({ where: { refType: 'release', refId: { in: ids }, action: CONFIRM_CHANGE, status: { in: ['OPEN', 'TRANSFERRED'] } }, select: { refId: true, ownerId: true, status: true, createdAt: true } }),
    prisma.routeStep.groupBy({ by: ['holdReleaseId'], where: { holdReleaseId: { in: ids } }, _count: { _all: true } }),
    prisma.releaseReceipt.groupBy({ by: ['releaseId'], where: { releaseId: { in: ids }, status: 'PENDING' }, _count: { _all: true } }),
  ])
  const heldOf = new Map(held.map((h) => [h.holdReleaseId, h._count._all]))
  const pendingOf = new Map(pending.map((p) => [p.releaseId, p._count._all]))
  const out: Target[] = []
  const pick: { rel: (typeof rels)[number]; owners: string[]; startAt: Date }[] = []
  for (const rel of rels) {
    const mine = todos.filter((x) => x.refId === rel.id)
    const open = [...new Set(mine.filter((x) => x.status === 'OPEN').map((x) => x.ownerId))]
    if (open.length) {
      // 转交过的从最早发出起算，转交不重新计时
      const startAt = new Date(Math.min(...mine.map((x) => x.createdAt.getTime())))
      pick.push({ rel, owners: open, startAt })
    } else if ((heldOf.get(rel.id) ?? 0) > 0 && !pendingOf.get(rel.id)) {
      pick.push({ rel, owners: [rel.issuerId], startAt: rel.createdAt })
    }
  }
  if (!pick.length) return out
  const names = await loadNames({ user: pick.flatMap((x) => x.owners) })
  for (const { rel, owners, startAt } of pick) {
    const elapsed = elapsedExcludingOffDays(startAt, now, offDays)
    const who = owners.map((id) => names.user.get(id) ?? id).join('、')
    out.push({
      rule: 'W5',
      refType: 'release',
      refId: rel.id,
      key: alertKey('W5', 'release', rel.id),
      workOrderNumber: rel.workOrderNumber,
      ownerIds: owners,
      watcherIds: [rel.issuerId],
      startAt,
      level: levelByElapsed(elapsed, t.W5),
      subject: `${TYPE_TEXT[rel.type]} ${rel.releaseNo}${rel.version ? `（${rel.version}）` : ''}`,
      summary: `已发放 ${durationText(elapsed)}，变更影响仍未确认（待 ${who} 确认）`,
      meta: { releaseId: rel.id },
    })
  }
  return out
}
