import { prisma } from '../../../utils/prisma'
import { loadNames } from '../../flow/names'
import { BUSINESS_DEPT_NAME } from '../../auth/departments'
import { CONFIRM_PLAN_NODE, PLAN_REF, judgeSplit, judgeW9, judgeW9Plan, w9ConfirmKey, w9Key, w9PlanKey, w9PlanSummary, w9SplitKey, w9Summary } from '../../plan/constants'
import { loadPlans } from '../../plan/plan'
import { type Thresholds, dateFieldDay, durationText, elapsedExcludingOffDays, levelByElapsed } from '../rules'
import type { Target } from '../types'

/**
 * W9 总计划（R14），只看已发布的总计划、QMS 里还在（未删除）的工单：
 *   节点延误（planNode）：只报源头节点（不计上游顺延、自身就已延误），按自身延误天数判定，见 plan/constants.ts judgeW9（晚 1 天黄、3 天红）；
 *     只因上游顺延而晚的节点不报（页面标"受上游影响"），免得一处延误沿主线报一串。
 *     责任人是节点责任部门的负责人，责任部门是该部门（黄色起再通知项目经理，红色再加项目部负责人、分管领导）。
 *     节点完成、或自身不再延误时对象消失，本轮扫描自动消除；改计划日时服务层先清掉，按新日期重算。
 *   交期风险（plan，refId = 工单号）：预计交期晚于 QMS 交期 → 红，一个工单一条；责任人是项目经理（红色阶梯再加项目部负责人、分管领导）。
 *   节点超时未确认（planConfirm）：发布（或改期）后还有打开的"确认总计划节点"待办，按 W5 的阈值计时（从最早一条待办起，转交不重新计时；
 *     停工日不计）；责任人是待办人，黄色起通知项目经理和责任部门负责人，红色再加项目部负责人、分管领导。确认 / 退回后消失。
 *   节点未分解（planSplit，部门计划二次分解）：发布（发布后加的节点从加的时候）起过了 W9 的提醒小时数（默认 72，停工日不计），
 *     节点没完成、下面没有任何部门任务 → 只提醒（REMIND）责任部门负责人，不升级；分解了（挂上任何一条记录）或节点完成后消失。
 * 都不转异常。
 */
export async function collectW9(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const plans = await loadPlans({ publishedOnly: true }, now)
  if (!plans.size) return []
  const wos = [...plans.keys()]
  const nodeIds = [...plans.values()].flatMap((p) => p.nodes.map((n) => n.id))
  const [live, heads, todos, exts] = await Promise.all([
    prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: wos }, isDeleted: false }, select: { workOrderNumber: true } }),
    prisma.notifyRole.findMany({ where: { role: { in: ['DEPT_HEAD', 'PROJECT_DEPT_HEAD'] } }, select: { role: true, userId: true, department: true } }),
    nodeIds.length
      ? prisma.todo.findMany({ where: { refType: PLAN_REF, refId: { in: nodeIds }, action: CONFIRM_PLAN_NODE, status: { in: ['OPEN', 'TRANSFERRED'] } }, select: { refId: true, ownerId: true, status: true, createdAt: true } })
      : [],
    prisma.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, projectManagerId: true } }),
  ])
  const pmOf = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  const liveWos = new Set(live.map((w) => w.workOrderNumber))
  const headsOf = (dept: keyof typeof BUSINESS_DEPT_NAME) =>
    [...new Set(heads.filter((h) => (h.role === 'DEPT_HEAD' && h.department === BUSINESS_DEPT_NAME[dept]) || (dept === 'PROJECT' && h.role === 'PROJECT_DEPT_HEAD')).map((h) => h.userId))]
  const names = await loadNames({ user: todos.map((x) => x.ownerId) })
  const out: Target[] = []
  for (const plan of plans.values()) {
    if (!liveWos.has(plan.workOrderNumber)) continue
    const f = plan.forecast
    const late = plan.deliveryDay ? judgeW9Plan(f.deliveryDelayDays) : null
    if (late) {
      const pm = pmOf.get(plan.workOrderNumber)
      out.push({
        rule: 'W9',
        refType: 'plan',
        refId: plan.workOrderNumber,
        key: w9PlanKey(plan.workOrderNumber),
        workOrderNumber: plan.workOrderNumber,
        ownerIds: pm ? [pm] : [],
        deptNames: [], // 不找部门负责人：红色阶梯加项目部负责人、分管领导
        startAt: now,
        level: late,
        subject: '总计划预计交期',
        summary: w9PlanSummary(plan.deliveryDay!, f, plan.nodes.filter((n) => f.nodes.find((x) => x.id === n.id)?.source).map((n) => n.name)),
      })
    }
    for (const n of plan.nodes) {
      const e = f.nodes.find((x) => x.id === n.id)!
      const dept = BUSINESS_DEPT_NAME[n.dept]
      const subject = `总计划节点 ${n.name}（${dept}）`
      const level = judgeW9(e, t.W9)
      if (level) {
        out.push({
          rule: 'W9',
          refType: 'planNode',
          refId: n.id,
          key: w9Key(n.id),
          workOrderNumber: plan.workOrderNumber,
          ownerIds: headsOf(n.dept),
          deptNames: [dept],
          startAt: n.planDate,
          level,
          subject,
          summary: w9Summary(e, dateFieldDay(n.planDate)),
        })
      }
      // 节点未分解（部门计划二次分解）：发布（发布后加的节点从加的时候）起过了 W9 提醒小时数仍没有任何部门任务 → 提醒责任部门负责人
      const splitFrom = new Date(Math.max(+(plan.publishedAt ?? n.createdAt), +n.createdAt))
      const splitElapsed = elapsedExcludingOffDays(splitFrom, now, offDays)
      const split = judgeSplit({ done: e.done, taskCount: e.taskCount + e.children.length }, splitElapsed, t.W9.remindHours)
      if (split) {
        out.push({
          rule: 'W9',
          refType: 'planSplit',
          refId: n.id,
          key: w9SplitKey(n.id),
          workOrderNumber: plan.workOrderNumber,
          ownerIds: headsOf(n.dept),
          deptNames: [dept],
          startAt: splitFrom,
          level: split,
          subject,
          summary: `计划 ${dateFieldDay(n.planDate)}，总计划发布已 ${durationText(splitElapsed)}，还没有分解部门任务（请在"部门计划"里分解：设计任务、采购行、工序、装配节点或其他任务）`,
        })
      }
      if (n.confirmStatus !== 'PENDING') continue
      const mine = todos.filter((x) => x.refId === n.id)
      const open = [...new Set(mine.filter((x) => x.status === 'OPEN').map((x) => x.ownerId))]
      if (!open.length) continue
      const startAt = new Date(Math.min(...mine.map((x) => +x.createdAt)))
      const elapsed = elapsedExcludingOffDays(startAt, now, offDays)
      out.push({
        rule: 'W9',
        refType: 'planConfirm',
        refId: n.id,
        key: w9ConfirmKey(n.id),
        workOrderNumber: plan.workOrderNumber,
        ownerIds: open,
        deptNames: [dept],
        startAt,
        level: levelByElapsed(elapsed, t.W5),
        subject,
        summary: `计划 ${dateFieldDay(n.planDate)}，发布已 ${durationText(elapsed)}，部门还没接收（待 ${open.map((id) => names.user.get(id) ?? id).join('、')} 在"部门计划"里接收）`,
      })
    }
  }
  return out
}
