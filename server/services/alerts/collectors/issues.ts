import { prisma } from '../../../utils/prisma'
import { resolveDeptNames } from '../../auth/departments'
import { CATEGORY_TEXT } from '../../issues/constants'
import { alertKey, type Thresholds, dateFieldDay, durationText, judgeW4 } from '../rules'
import type { Target } from '../types'

/**
 * W4：待受理、处理中的异常。责任人是异常责任人，没有时是项目部负责人；
 * 黄色起通知异常上写明的责任部门的负责人（不是责任人所在部门）。
 */
export async function collectW4(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const issues = await prisma.issue.findMany({ where: { status: { in: ['OPEN', 'ACCEPTED'] } } })
  if (!issues.length) return []
  const [pdh, deptName] = await Promise.all([
    prisma.notifyRole.findMany({ where: { role: 'PROJECT_DEPT_HEAD' }, select: { userId: true } }),
    // 责任部门（QMS 部门 ID）换成业务部门名称后与部门负责人对应（dept_mapping，没对照时用部门名称本身）
    resolveDeptNames(issues.map((i) => i.responsibleDeptId)),
  ])
  const fallback = [...new Set(pdh.map((p) => p.userId))]
  return issues.map((i) => {
    const r = judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, t.W4)
    const summary =
      r.overdueDays > 0
        ? `超要求解决日 ${dateFieldDay(i.dueDate!)} ${r.overdueDays} 天未解决`
        : i.status === 'OPEN'
          ? `待受理 ${durationText(r.openMs)}`
          : `要求 ${i.dueDate ? dateFieldDay(i.dueDate) : '—'} 前解决`
    const dept = i.responsibleDeptId ? deptName.get(i.responsibleDeptId) : undefined
    return {
      rule: 'W4',
      refType: 'issue',
      refId: i.id,
      key: alertKey('W4', 'issue', i.id),
      workOrderNumber: i.workOrderNumber,
      ownerIds: i.responsibleUserId ? [i.responsibleUserId] : fallback,
      deptNames: dept ? [dept] : undefined,
      startAt: i.status === 'OPEN' && !r.overdueDays ? i.createdAt : (i.dueDate ?? i.createdAt),
      level: r.level,
      subject: `异常 ${i.issueNo}（${CATEGORY_TEXT[i.category]}）`,
      summary,
    }
  })
}
