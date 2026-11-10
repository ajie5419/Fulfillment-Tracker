import type { AlertLevel, NotifyRole } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { userDeptIdentities } from '../auth/departments'
import type { Target } from './types'

// ───────────── 通知对象 ─────────────

interface NotifyContext {
  roles: NotifyRole[]
  deptOf: Map<string, string>
  pmOf: Map<string, string | null>
}

export async function loadNotifyContext(targets: Pick<Target, 'ownerIds' | 'workOrderNumber'>[]): Promise<NotifyContext> {
  const ownerIds = [...new Set(targets.flatMap((x) => x.ownerIds))]
  const wos = [...new Set(targets.map((x) => x.workOrderNumber).filter((w): w is string => !!w))]
  const [roles, deptOf, exts] = await Promise.all([
    prisma.notifyRole.findMany(),
    // Resolve QMS IDs to stable business identities before matching department heads.
    userDeptIdentities(ownerIds),
    wos.length ? prisma.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } } }) : [],
  ])
  return {
    roles,
    deptOf,
    pmOf: new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId])),
  }
}

/**
 * 升级阶梯（方案 6.2）：
 *   提醒 = 责任人；黄 = 提醒 + 责任部门负责人 + 工单项目经理（+ watcherIds，如 W5 的发放人）；红 = 黄 + 项目部负责人 + 分管领导。
 * Routing uses departmentKeys; labels in deptNames are presentation-only.
 * 找不到的角色跳过，收件人去重。
 */
export function recipientsFor(level: AlertLevel, target: Pick<Target, 'ownerIds' | 'workOrderNumber' | 'departmentKeys' | 'watcherIds'>, ctx: NotifyContext): string[] {
  const out = new Set(target.ownerIds)
  if (level === 'YELLOW' || level === 'RED') {
    for (const id of target.watcherIds ?? []) out.add(id)
    const depts = new Set(target.departmentKeys ?? target.ownerIds.map((id) => ctx.deptOf.get(id)).filter(Boolean))
    for (const r of ctx.roles) if (r.role === 'DEPT_HEAD' && r.department && depts.has(r.department)) out.add(r.userId)
    const pm = target.workOrderNumber ? ctx.pmOf.get(target.workOrderNumber) : null
    if (pm) out.add(pm)
  }
  if (level === 'RED') {
    for (const r of ctx.roles) if (r.role === 'PROJECT_DEPT_HEAD' || r.role === 'LEADER') out.add(r.userId)
  }
  return [...out]
}
