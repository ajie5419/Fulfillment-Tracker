/**
 * 班组长（生产管理重设计第二批）：设置页"班组长"维护，一个班组一个班组长，一个人可以带多个班组。
 * 班组来自 QMS 同步（qms_supplier kind = TEAM）；班组长存在 team_leader，同步不碰它。
 * 换了 / 清除班组长：这些班组里没指定负责人的待开工自制工序，没处理的待办按改前、改后的"谁负责"转交（同改负责人，steps.moveStepTodos）。
 */
import type { Prisma } from '@prisma/client'
import { isDeadlock, prisma } from '../../utils/prisma'
import { FlowError } from './errors'
import { loadNames } from './names'
import { lockParts } from '../purchases/purchases'
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

/** 锁后发现又有工序进了这个班组（它的工件没锁上）：整个事务回滚重来 */
class TeamStepsChanged extends Error {}

/**
 * 设置 / 清除班组长（userId = null 清除）。
 *
 * 锁顺序（全系统统一，见 server/utils/prisma.ts）：工件 → 工序 → 班组行。
 *   发 / 转待办时算"谁负责"（flow/responsible.ts，lock）会对班组行加共享锁再读班组长；这里先锁这个班组相关工序的工件，
 *   再对班组行加排他锁，然后锁后重读工序。正在给这个班组的工序发待办的事务要么已提交（重读能看到），
 *   要么卡在班组行的共享锁上、等这里提交后读到新班组长。锁后重读发现有工序的工件不在已锁集合里（等锁期间新进了这个班组）：
 *   回滚重来，绝不在持有班组行锁之后再去锁工件（否则和上面的顺序成环）。
 */
export async function setTeamLeader(teamId: string, userId: string | null, actorId: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      // 每道工序逐个算"谁负责"、转待办：一个班组一般几十道待开工工序，默认 5 秒事务超时偏紧，放宽到 15 秒（不做分批，分批会破坏原子性）
      return await prisma.$transaction((tx) => setTeamLeaderTx(tx, teamId, userId, actorId), { timeout: 15_000, maxWait: 5_000 })
    } catch (err) {
      if (attempt < 4 && (err instanceof TeamStepsChanged || isDeadlock(err))) continue
      if (err instanceof TeamStepsChanged) throw new FlowError('这个班组的工序正在调整，请稍后再试')
      throw err
    }
  }
}

async function setTeamLeaderTx(tx: Prisma.TransactionClient, teamId: string, userId: string | null, actorId: string) {
  // 这个班组里没指定负责人的待开工自制工序：先锁它们的工件
  const where = { mode: 'SELF' as const, supplierId: teamId, ownerId: null, status: 'PENDING' as const }
  const partIds = new Set((await tx.routeStep.findMany({ where, select: { partId: true } })).map((r) => r.partId))
  await lockParts(tx, [...partIds])
  // 再锁班组行（发待办时对它加共享锁读班组长）
  const [team] = await tx.$queryRaw<{ id: string; kind: string; isDeleted: number | boolean }[]>`SELECT id, kind, isDeleted FROM qms_supplier WHERE id = ${teamId} FOR UPDATE`
  if (!team || team.kind !== 'TEAM' || Boolean(team.isDeleted)) throw new FlowError('班组不存在或已删除')
  if (userId) {
    const u = await tx.qmsUser.findFirst({ where: { id: userId, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
    if (!u) throw new FlowError('班组长不存在或已停用')
  }
  const old = await tx.teamLeader.findUnique({ where: { supplierId: teamId }, select: { userId: true } })
  if ((old?.userId ?? null) === userId) return { changed: false, moved: 0 }
  // 锁后重读（READ COMMITTED：看到最新状态，等锁期间已开工 / 已改走的不再算）
  const steps = await tx.routeStep.findMany({
    where,
    select: { id: true, partId: true, seq: true, ownerId: true, mode: true, supplierId: true, part: { select: { workOrderNumber: true } } },
  })
  if (steps.some((s) => !partIds.has(s.partId))) throw new TeamStepsChanged()
  // 改之前算"待办现在按规则在谁手里"（原班组长看不到工单时是兜底的人）
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
}
