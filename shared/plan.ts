/** 页面叫“接收”；数据库保留原确认状态码。 */
export const PLAN_CONFIRM_TEXT = { PENDING: '待接收', CONFIRMED: '已接收', REJECTED: '已退回' } as const
export type PlanConfirmStatus = keyof typeof PLAN_CONFIRM_TEXT

/** 其他任务是部门计划二次分解记录，另四类直接挂靠业务记录。 */
export type TaskKind = 'drawing' | 'purchase' | 'step' | 'assembly' | 'task'
export const TASK_KIND_TEXT: Record<TaskKind, string> = { drawing: '设计', purchase: '采购', step: '工序', assembly: '装配', task: '其他任务' }

export type PlanListStatus = 'NONE' | 'DRAFT' | 'PUBLISHED'
