/**
 * 工序"谁负责"的唯一口径（生产管理重设计第二批）：
 *
 *   工序负责人（route_step.ownerId）→ 自制工序派到的班组的班组长（team_leader）→ 调用方原来的兜底（null 时由调用方决定）。
 *
 * 只有自制工序（mode = SELF）的班组算"本班组的活"：厂内外协、厂外外协的 supplierId 是外协单位，不找班组长。
 * 班组长要在职（QMS 用户未删除、ACTIVE），班组要还在（未删除、kind = TEAM）；
 * 班组长看不到这个工单（只看本人工单的项目经理）时不发给他——待办 / 提醒里带工单号（#37 的规则），退回调用方的兜底。
 *
 * 下一道的"安排发出 / 开工"（flow.applyReturn）、第一道的"可以开工"（purchases.refreshPartReady）、
 * W3 / W10 预警、改负责人 / 班组时转交待办（steps.updateStepTx）都走这里。W2 的接收人是待办负责人，待办本身已按这里发。
 */
import { Prisma, type StepMode } from '@prisma/client'
// 后台负责人解析只需要工单可见范围，不依赖请求鉴权与角色加载（auth 会反过来加载班组长）。
import { canSee, resolveScopes } from '../auth/scope'
import { leaderTeamOfStep } from '../../../shared/permissions'
import { prisma } from '../../utils/prisma'

type Db = Prisma.TransactionClient | typeof prisma

export interface ResponsibleStep {
  ownerId: string | null
  mode: StepMode
  supplierId: string | null
  /** 所属工单（判断班组长看不看得到） */
  workOrderNumber: string
}

/** 工序所属的班组：只有自制工序派到的班组算 */
export const teamOfStep = (s: Pick<ResponsibleStep, 'mode' | 'supplierId'>) => leaderTeamOfStep(s)

/**
 * 纯函数（单测用）：负责人优先，其次班组长（看得到这个工单才算）；都没有返回 null。
 * leaderOf：班组 → 班组长；leaderCanSee：班组长能不能看这个工单。
 */
export function pickResponsible(s: ResponsibleStep, leaderOf: ReadonlyMap<string, string>, leaderCanSee: (userId: string, workOrderNumber: string) => boolean): string | null {
  if (s.ownerId) return s.ownerId
  const team = teamOfStep(s)
  const leader = team ? leaderOf.get(team) : undefined
  return leader && leaderCanSee(leader, s.workOrderNumber) ? leader : null
}

/** 这些班组的班组长（班组还在、班组长在职的） */
export async function leadersOf(db: Db, teamIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(teamIds.filter((x): x is string => !!x))]
  if (!ids.length) return new Map()
  const rows = await db.teamLeader.findMany({
    where: { supplierId: { in: ids }, team: { isDeleted: false, kind: 'TEAM' }, user: { isDeleted: false, status: 'ACTIVE' } },
    select: { supplierId: true, userId: true },
  })
  return new Map(rows.map((r) => [r.supplierId, r.userId]))
}

/** 本人担任班组长的班组（还在的） */
export async function teamsLedBy(db: Db, userId: string): Promise<string[]> {
  const rows = await db.teamLeader.findMany({ where: { userId, team: { isDeleted: false, kind: 'TEAM' } }, select: { supplierId: true } })
  return rows.map((r) => r.supplierId)
}

/**
 * 批量：每道工序的负责人（顺序同入参），没有为 null。
 * lock：在事务里要按结果发 / 转待办时传 true——先对涉及的班组行加共享锁再读班组长，和换班组长（team-leaders.ts，排他锁）串行。
 * 锁顺序：调用方已锁工件（和工序），班组行最后锁（工件 → 工序 → 班组行，见 server/utils/prisma.ts）。只读展示（列表、预警扫描）不用锁。
 */
export async function resolveStepResponsibles(db: Db, steps: ResponsibleStep[], opts: { lock?: boolean } = {}): Promise<(string | null)[]> {
  const teams = [...new Set(steps.filter((s) => !s.ownerId).map(teamOfStep).filter((x): x is string => !!x))].sort()
  if (opts.lock && teams.length) await db.$queryRaw`SELECT id FROM qms_supplier WHERE id IN (${Prisma.join(teams)}) ORDER BY id FOR SHARE`
  const leaders = await leadersOf(db, teams)
  // 班组长的可见范围（每人只算一次）。后台流程没有请求上下文，不按管理员放宽：班组长同时是"只看本人工单的项目经理"时按项目经理算
  const scopes = await resolveScopes([...leaders.values()], [], db)
  return steps.map((s) => pickResponsible(s, leaders, (uid, wo) => canSee(scopes.get(uid)!, wo)))
}

export async function resolveStepResponsible(db: Db, step: ResponsibleStep, opts: { lock?: boolean } = {}): Promise<string | null> {
  return (await resolveStepResponsibles(db, [step], opts))[0] ?? null
}
