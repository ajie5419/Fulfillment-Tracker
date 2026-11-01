import type { PlanConfirmStatus } from '#shared/plan'

/** 接收状态的 UI 色调（桌面与手机共用）；状态码约束来自共享领域。 */
export const CONFIRM_TONE = { PENDING: 'risk', CONFIRMED: 'done', REJECTED: 'late' } as const satisfies Record<PlanConfirmStatus, string>
