import type { Issue } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { alertKey } from '../alerts/rules'
import { loadDeptIndex, resolveDeptNames } from '../auth/departments'
import { loadNames } from '../flow/names'

import type { Db, Actor, PermContext } from './types'
import { projectIssues } from './projection'

export async function loadPermContext(db: Db, actor: Actor, issues: Pick<Issue, 'responsibleDeptId' | 'workOrderNumber'>[]): Promise<PermContext> {
  const deptIds = [...new Set(issues.map((i) => i.responsibleDeptId).filter((x): x is string => !!x))]
  const wos = [...new Set(issues.map((i) => i.workOrderNumber))]
  const [roles, deptName, exts] = await Promise.all([
    db.notifyRole.findMany({ where: { userId: actor.userId } }),
    // 责任部门（QMS 部门 ID）换成业务部门名称，与部门负责人的 department 对应
    resolveDeptNames(deptIds),
    wos.length ? db.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, projectManagerId: true } }) : [],
  ])
  return {
    actor,
    roles,
    deptName,
    pmOf: new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId])),
  }
}

/** 给异常补上名称、关联对象文字、超期情况和当前用户可做的操作 */
export async function loadIssueSources(issues: Issue[], actor: Actor) {
  const [ctx, thresholds, offDays, depts, deptIndex] = await Promise.all([
    loadPermContext(prisma, actor, issues),
    loadThresholds(),
    loadOffDays(),
    prisma.qmsDepartment.findMany({ where: { id: { in: issues.map((i) => i.responsibleDeptId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    loadDeptIndex(),
  ])
  const stepIds = issues.filter((i) => i.refType === 'STEP' && i.refId).map((i) => i.refId!)
  const partIds = issues.filter((i) => i.refType === 'PART' && i.refId).map((i) => i.refId!)
  const [steps, parts, alerts] = await Promise.all([
    stepIds.length ? prisma.routeStep.findMany({ where: { id: { in: stepIds } }, include: { part: { select: { id: true, name: true } } } }) : [],
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true } }) : [],
    prisma.alert.findMany({ where: { activeKey: { in: issues.map((i) => alertKey('W4', 'issue', i.id)) } }, select: { refId: true, level: true } }),
  ])
  const names = await loadNames({
    user: issues.flatMap((i) => [i.responsibleUserId, i.reporterId]),
    supplier: issues.map((i) => i.responsibleSupplierId),
    process: steps.map((s) => s.processId),
  })
  return { ctx, thresholds, offDays, depts, deptIndex, steps, parts, alerts, names }
}

/** 批量装配入口：空集合不触发来源查询。 */
export async function decorate(issues: Issue[], actor: Actor, now: Date) {
  if (!issues.length) return []
  const sources = await loadIssueSources(issues, actor)
  return projectIssues(issues, sources, now)
}
