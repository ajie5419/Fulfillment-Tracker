/** 页面叫“接收”；数据库保留原确认状态码。 */
export const PLAN_CONFIRM_TEXT = { PENDING: '待接收', CONFIRMED: '已接收', REJECTED: '已退回' } as const
export type PlanConfirmStatus = keyof typeof PLAN_CONFIRM_TEXT
