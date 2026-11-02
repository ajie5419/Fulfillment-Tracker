/** 工单保存的兼容响应：没有 recovery 表示本地提交完成；PENDING 表示远端已成功。 */
export interface WorkOrderSaveResult {
  workOrderNumber: string
  status: string
  version: number | null
  updatedAt: Date
  recovery?: {
    status: 'PENDING'
    operationId: string
    message: string
  }
}

export const WORK_ORDER_SAVE_OPERATIONS = ['create', 'update'] as const
export const WORK_ORDER_SAVE_STATES = ['PENDING', 'DONE'] as const
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128
