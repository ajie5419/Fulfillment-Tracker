import { prisma } from '../../../utils/prisma'
import { loadNames } from '../../flow/names'
import { DRAWING_STATUS_TEXT, OPEN_DRAWING_STATUSES, TECH_DEPT, judgeW7, w7Summary } from '../../drawings/constants'
import { alertKey, type Thresholds } from '../rules'
import type { Target } from '../types'

/**
 * W7 设计逾期（R11）：未完成、未取消的设计任务，判定见 drawings/constants.ts judgeW7
 * （计划完成日前 N 天仍未完成设计黄、已过计划完成日红；设计完成、需要客户确认的，超客户确认计划日黄 → 红）。
 * 责任人：设计负责人，没指定时是技术部负责人；责任部门是技术部（黄色起通知技术部负责人、工单项目经理，红色再加项目部负责人、分管领导）。
 * 只看 QMS 里还在（未删除）的工单。红色不转异常。
 */
export async function collectW7(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const tasks = await prisma.drawingTask.findMany({ where: { status: { in: OPEN_DRAWING_STATUSES } } })
  if (!tasks.length) return []
  const [wos, heads] = await Promise.all([
    prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: [...new Set(tasks.map((x) => x.workOrderNumber))] }, isDeleted: false }, select: { workOrderNumber: true } }),
    prisma.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: TECH_DEPT }, select: { userId: true } }),
  ])
  const live = new Set(wos.map((w) => w.workOrderNumber))
  const headIds = [...new Set(heads.map((h) => h.userId))]
  const names = await loadNames({ user: tasks.map((x) => x.ownerId) })
  const out: Target[] = []
  for (const d of tasks) {
    if (!live.has(d.workOrderNumber)) continue
    const r = judgeW7({ ...d, now, offDays }, t.W7)
    if (!r.level) continue
    const owner = d.ownerId ? (names.user.get(d.ownerId) ?? d.ownerId) : `${TECH_DEPT}负责人`
    out.push({
      rule: 'W7',
      refType: 'drawing',
      refId: d.id,
      key: alertKey('W7', 'drawing', d.id),
      workOrderNumber: d.workOrderNumber,
      ownerIds: d.ownerId ? [d.ownerId] : headIds,
      deptNames: [TECH_DEPT],
      startAt: r.trigger === 'CONFIRM_OVERDUE' ? d.customerPlanDate! : d.planDate,
      level: r.level,
      subject: `设计 ${d.componentName}（${DRAWING_STATUS_TEXT[d.status]}）`,
      summary: w7Summary(r, d, owner),
    })
  }
  return out
}
