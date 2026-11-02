import type { AlertLevel, NotifyRole } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { userDeptNames } from '../auth/departments'
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
    // 用户的部门是 QMS 部门 ID，换成业务部门名称（dept_mapping，没对照时用部门名称本身）后与 notify_role.department 对应
    userDeptNames(ownerIds),
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
 * 责任部门（名称）：target.deptNames（W4 异常上写明的），没有时取责任人所在部门（部门 ID 经 dept_mapping 换成业务部门名称）。
 * 找不到的角色跳过，收件人去重。
 */
export function recipientsFor(level: AlertLevel, target: Pick<Target, 'ownerIds' | 'workOrderNumber' | 'deptNames' | 'watcherIds'>, ctx: NotifyContext): string[] {
  const out = new Set(target.ownerIds)
  if (level === 'YELLOW' || level === 'RED') {
    for (const id of target.watcherIds ?? []) out.add(id)
    const depts = new Set(target.deptNames ?? target.ownerIds.map((id) => ctx.deptOf.get(id)).filter(Boolean))
    for (const r of ctx.roles) if (r.role === 'DEPT_HEAD' && r.department && depts.has(r.department)) out.add(r.userId)
    const pm = target.workOrderNumber ? ctx.pmOf.get(target.workOrderNumber) : null
    if (pm) out.add(pm)
  }
  if (level === 'RED') {
    for (const r of ctx.roles) if (r.role === 'PROJECT_DEPT_HEAD' || r.role === 'LEADER') out.add(r.userId)
  }
  return [...out]
}
