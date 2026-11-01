/** 各业务记录转为任务事实，并估算任务自己的完成日。 */
import type { DrawingTaskStatus, PurchaseStatus, StepMode, StepStatus } from '@prisma/client'
import { isDesignComplete } from '../../../shared/drawing'
import type { TaskFacts, TaskEstimate } from './estimate-types'

export function estimateTask(t: TaskFacts, nodePlanDay: string, today: string): TaskEstimate {
  const lateForNode = !t.excluded && !!t.planDay && t.planDay > nodePlanDay
  if (t.excluded) return { expectedDay: null, overdue: false, lateForNode: false }
  if (t.done) return { expectedDay: t.doneDay ?? today, overdue: false, lateForNode }
  if (!t.planDay) return { expectedDay: null, overdue: false, lateForNode }
  const overdue = t.planDay < today
  return { expectedDay: overdue ? today : t.planDay, overdue, lateForNode }
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

/** 设计任务：完成 = 已完成设计（含待确认、已发放）；设计完成等客户确认的看客户确认计划日 */
export function drawingFacts(
  d: { id: string; status: DrawingTaskStatus; planDate: Date; drawnDate: Date | null; needsCustomerConfirm: boolean; customerPlanDate: Date | null; customerConfirmedDate: Date | null },
): TaskFacts {
  const waitingCustomer = !!d.drawnDate && d.needsCustomerConfirm && !d.customerConfirmedDate && !!d.customerPlanDate
  return {
    kind: 'drawing',
    id: d.id,
    excluded: d.status === 'CANCELLED',
    done: isDesignComplete(d.status),
    doneDay: day(d.customerConfirmedDate) ?? day(d.drawnDate),
    planDay: waitingCustomer ? day(d.customerPlanDate) : day(d.planDate),
  }
}

/** 采购行：完成 = 已到货；有承诺到货日看承诺日，否则看需求日 */
export function purchaseFacts(l: { id: string; status: PurchaseStatus; needDate: Date; promisedDate: Date | null; arrivedDate: Date | null }): TaskFacts {
  return {
    kind: 'purchase',
    id: l.id,
    excluded: l.status === 'CANCELLED',
    done: l.status === 'ARRIVED',
    doneDay: day(l.arrivedDate),
    planDay: day(l.promisedDate) ?? day(l.needDate),
  }
}

/** 工序：完成 = 已完成（完成日按工厂时区）；厂外外协有承诺返回日看承诺返回日，否则看要求完成日 */
export function stepFacts(
  s: { id: string; status: StepStatus; mode: StepMode; dueDate: Date | null; promisedReturnDate: Date | null; finishedAt: Date | null },
  toShanghaiDay: (t: Date) => string,
): TaskFacts {
  const promised = s.mode === 'EXTERNAL_OUTSOURCE' ? day(s.promisedReturnDate) : null
  return {
    kind: 'step',
    id: s.id,
    excluded: false,
    done: s.status === 'DONE',
    doneDay: s.finishedAt ? toShanghaiDay(s.finishedAt) : null,
    planDay: promised ?? day(s.dueDate),
  }
}

/**
 * 装配节点（齐套）：完成 = 清单不为空且全部就绪（齐套）。
 * 完成日 = 齐套日（最后一项就绪的那天：工件置为完成的时刻、物料到货日，见 kitting/constants.ts countKit），都是落了库的日期。
 * 以前齐套时刻没取，完成日按"需求日和今天较早的那个"现算，提前齐套的节点完成日会每天往后挪（项目日历的实际完成会跟着变），10-21 改为取记录日期。
 * 缺日期（老数据工件没有 statusSince 一般不会发生）时为 null，按"不知道完成日"处理（autoDone 按今天算，项目日历不计入实际完成）。
 */
export function assemblyFacts(n: { id: string; needDate: Date }, kit: { total: number; ready: number; readyDay?: string | null }, _today: string): TaskFacts {
  const need = day(n.needDate)!
  const done = kit.total > 0 && kit.ready >= kit.total
  return { kind: 'assembly', id: n.id, excluded: false, done, doneDay: done ? (kit.readyDay ?? null) : null, planDay: need }
}

/** 其他任务：完成 = 填了完成日；看计划完成日 */
export function planTaskFacts(t: { id: string; planDate: Date; doneDate: Date | null }): TaskFacts {
  return { kind: 'task', id: t.id, excluded: false, done: !!t.doneDate, doneDay: day(t.doneDate), planDay: day(t.planDate) }
}
