/**
 * 班组长（生产管理重设计第二批）：设置页"班组长"维护，一个班组一个班组长，一个人可以带多个班组。
 * 班组来自 QMS 同步（qms_supplier kind = TEAM）；班组长存在 team_leader，同步不碰它。
 * 换了 / 清除班组长：这些班组里没指定负责人的待开工自制工序，没处理的待办按改前、改后的"谁负责"转交（同改负责人，steps.moveStepTodos）。
 */
import { prisma } from '../../utils/prisma'
import { FlowError } from './errors'
import { loadNames } from './names'
import { moveStepTodos, stepTodoHolders } from './steps'

/** 全部班组（未删除的）和班组长 */
export async function listTeamLeaders() {
  const teams = await prisma.qmsSupplier.findMany({
    where: { kind: 'TEAM', isDeleted: false },
    select: { id: true, name: true, status: true, leader: { select: { userId: true, updatedAt: true, updatedBy: true } } },
    orderBy: { name: 'asc' },
  })
  const names = await loadNames({ user: teams.flatMap((t) => (t.leader ? [t.leader.userId, t.leader.updatedBy] : [])) })
  return teams.map((t) => ({
    teamId: t.id,
    teamName: t.name,
    /** QMS 班组状态：ACTIVE / INACTIVE */
    active: t.status !== 'INACTIVE',
    leaderId: t.leader?.userId ?? null,
    leaderName: t.leader ? (names.user.get(t.leader.userId) ?? t.leader.userId) : null,
    updatedAt: t.leader?.updatedAt ?? null,
    updatedByName: t.leader ? (names.user.get(t.leader.updatedBy) ?? t.leader.updatedBy) : null,
  }))
}

/** 设置 / 清除班组长（userId = null 清除） */
export async function setTeamLeader(teamId: string, userId: string | null, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const [team] = await tx.$queryRaw<{ id: string; kind: string; isDeleted: number | boolean }[]>`SELECT id, kind, isDeleted FROM qms_supplier WHERE id = ${teamId} FOR UPDATE`
    if (!team || team.kind !== 'TEAM' || Boolean(team.isDeleted)) throw new FlowError('班组不存在或已删除')
    if (userId) {
      const u = await tx.qmsUser.findFirst({ where: { id: userId, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
      if (!u) throw new FlowError('班组长不存在或已停用')
    }
    const old = await tx.teamLeader.findUnique({ where: { supplierId: teamId }, select: { userId: true } })
    if ((old?.userId ?? null) === userId) return { changed: false, moved: 0 }
    // 这个班组里没指定负责人的待开工自制工序：改之前先算"待办现在按规则在谁手里"（原班组长看不到工单时是兜底的人）
    const steps = await tx.routeStep.findMany({
      where: { mode: 'SELF', supplierId: teamId, ownerId: null, status: 'PENDING' },
      select: { id: true, partId: true, seq: true, ownerId: true, mode: true, supplierId: true, part: { select: { workOrderNumber: true } } },
    })
    const before = []
    for (const s of steps) before.push(await stepTodoHolders(tx, s, s.part.workOrderNumber))
    if (userId) {
      await tx.teamLeader.upsert({ where: { supplierId: teamId }, create: { supplierId: teamId, userId, updatedBy: actorId }, update: { userId, updatedBy: actorId } })
    } else {
      await tx.teamLeader.delete({ where: { supplierId: teamId } })
    }
    // 改之后再算一次，按同一套规则转交（清除班组长时转回兜底的人）
    for (const [i, s] of steps.entries()) await moveStepTodos(tx, s, before[i]!, await stepTodoHolders(tx, s, s.part.workOrderNumber))
    return { changed: true, moved: steps.length }
  })
}
