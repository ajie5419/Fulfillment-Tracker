import { dayDiff } from './dates'

export const DO_DESIGN_TASK = 'DO_DESIGN_TASK'
export const MAX_CUSTOMER_CONFIRMATION_NOTE_LENGTH = 500

/** Keep lifecycle facts separate from schedule warnings; callers supply factory-local today. */
export function drawingPresentation(task: {
  status: string; planDate: string; drawnDate: string | null; released: boolean;
  needsCustomerConfirm: boolean; customerPlanDate: string | null; customerConfirmedDate: string | null;
  alertLevel: string | null;
}, today: string) {
  const cancelled = task.status === 'CANCELLED'
  const designText = cancelled ? '已取消' : task.drawnDate ? `设计完成 · ${task.released ? '已发放' : '待发放'}` : '设计中'
  const daysLeft = dayDiff(today, task.planDate)
  const designWarning = cancelled || task.drawnDate ? null : daysLeft < 0 ? `设计逾期 ${-daysLeft} 天`
    : task.alertLevel === 'YELLOW' ? daysLeft === 0 ? '设计今日到期' : daysLeft === 1 ? '设计明日到期' : `设计 ${daysLeft} 天后到期` : null
  const confirmDays = task.customerPlanDate ? dayDiff(today, task.customerPlanDate) : null
  const customerOverdue = !cancelled && task.needsCustomerConfirm && !task.customerConfirmedDate && confirmDays !== null && confirmDays < 0
  const customerText = cancelled || !task.needsCustomerConfirm ? null
    : task.customerConfirmedDate ? `已确认 · ${task.customerConfirmedDate.slice(5)}`
    : customerOverdue ? `客户确认逾期 ${-(confirmDays ?? 0)} 天`
    : `待客户确认 · ${task.customerPlanDate ? `计划 ${task.customerPlanDate.slice(5)}` : '日期未定'}`
  return { designText, designWarning, designOverdue: !!designWarning && daysLeft < 0, customerText, customerOverdue }
}

/** Design completed, including customer confirmation / release follow-up. */
export const isDesignComplete = (status: string) => ['DRAWN', 'CUSTOMER_PENDING', 'DONE'].includes(status)

/** 设计任务状态。 */
export const DRAWING_STATUS_TEXT = { PENDING: '设计中', DRAWN: '设计完成', CUSTOMER_PENDING: '待客户确认', DONE: '已完成', CANCELLED: '已取消' } as const
