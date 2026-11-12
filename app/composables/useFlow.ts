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
/** 'MM-DD' 短日期（用于看板卡片、聚焦迷你卡、甘特图紧凑列） */
export const shortDayText = (v: string | Date | null | undefined) => {
  if (!v) return ''
  const s = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : dayText(v)
  return s.length === 10 ? s.slice(5) : s
}
/** 紧凑日期区间：同年或同月自动省略重复前缀（如 '10-08 ~ 15' 或 '09-28 ~ 10-05'） */
export const shortRangeText = (start: string | Date | null | undefined, end: string | Date | null | undefined) => {
  const e = shortDayText(end)
  if (!start) return e
  const s = shortDayText(start)
  if (!s || s === e) return e
  return s.slice(0, 2) === e.slice(0, 2) ? `${s} ~ ${e.slice(3)}` : `${s} ~ ${e}`
}
export const timeText = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '')

/** 顶部双栏行动聚焦卡（UiSpotlightGrid）单栏默认最大展示条数 */
export const SPOTLIGHT_MAX_ITEMS = 4
/** 列表搜索框输入防抖毫秒数 */
export const FILTER_DEBOUNCE_MS = 300
/** 桌面端明细表格默认每页条数 */
export const DEFAULT_TABLE_PAGE_SIZE = 50

/** 兼容入口：保留经过小时数后取本地日期的原口径。 */
export { localDayAfter as dayAfter } from '#shared/dates'

export function useMaster() {
  return useApiFetch('/api/master', { key: 'master', default: () => ({ suppliers: [], processes: [], users: [] }) })
}

export function useWorkOrders() {
  return useApiFetch('/api/work-orders', { key: 'work-orders', default: () => [] })
}

export function useTodos() {
  return useApiFetch('/api/todos', { key: 'todos', default: () => [] })
}
