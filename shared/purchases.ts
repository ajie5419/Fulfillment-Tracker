export const MAX_PAYMENT_LINES = 50

/** 采购到货状态。 */
export const PURCHASE_STATUS_TEXT = { OPEN: '未到货', ARRIVED: '已到货', CANCELLED: '已取消' } as const

/** 采购延误原因。 */
export const DELAY_REASON_TEXT = { PAYMENT: '付款', SUPPLIER: '供应商', DEMAND_CHANGE: '我方需求变化', OTHER: '其他' } as const

/** 付款状态。 */
export const PAYMENT_STATUS_TEXT = { PENDING: '待付', PAID: '已付', ON_HOLD: '暂缓' } as const
