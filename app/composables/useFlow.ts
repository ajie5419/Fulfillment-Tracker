import { clientErrorMessage } from '../utils/transport'
import { STEP_STATUS_TEXT as SHARED_STEP_STATUS_TEXT, STEP_MODE_TEXT as SHARED_STEP_MODE_TEXT, FLOW_EVENT_TEXT as SHARED_FLOW_EVENT_TEXT, FLOW_SOURCE_TEXT as SHARED_FLOW_SOURCE_TEXT } from '#shared/flow'
/** 外协主链路页面共用：文案、颜色、接口错误信息、主数据下拉。 */

export const STATUS_TEXT = SHARED_STEP_STATUS_TEXT
export const STATUS_COLOR = { PENDING: 'default', OUT: 'processing', IN_PROGRESS: 'blue', DONE: 'success', BLOCKED: 'error' } as const
export const MODE_TEXT = SHARED_STEP_MODE_TEXT
export const EVENT_TEXT = SHARED_FLOW_EVENT_TEXT
export const SOURCE_TEXT = SHARED_FLOW_SOURCE_TEXT
export const REASON_TEXT = { NO_CANDIDATE: '没有对得上的步骤', MULTIPLE: '对上多个步骤', CANCELLED_AFTER_MATCH: '匹配后 QMS 撤销了报检' } as const

export type StepStatusKey = keyof typeof STATUS_TEXT
export type StepModeKey = keyof typeof MODE_TEXT

/** 接口返回的中文错误信息 */
export function apiError(e: unknown): string {
  return clientErrorMessage(e)
}

/** 'YYYY-MM-DD'；日期字段存的是当天 UTC 零点 */
export const dayText = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '')
export const timeText = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '')

/** 今天往后 n 天（本地时区），'YYYY-MM-DD' */
export function dayAfter(n: number) {
  const d = new Date(Date.now() + n * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function useMaster() {
  return useFetch('/api/master', { key: 'master', default: () => ({ suppliers: [], processes: [], users: [] }) })
}

export function useWorkOrders() {
  return useFetch('/api/work-orders', { key: 'work-orders', default: () => [] })
}

export function useTodos() {
  return useFetch('/api/todos', { key: 'todos', default: () => [] })
}
