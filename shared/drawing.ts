/** Design completed, including customer confirmation / release follow-up. */
export const isDesignComplete = (status: string) => ['DRAWN', 'CUSTOMER_PENDING', 'DONE'].includes(status)

/** 设计任务状态。 */
export const DRAWING_STATUS_TEXT = { PENDING: '设计中', DRAWN: '设计完成', CUSTOMER_PENDING: '待客户确认', DONE: '已完成', CANCELLED: '已取消' } as const
