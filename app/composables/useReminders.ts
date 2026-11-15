import { ALERT_LEVEL_TEXT as SHARED_ALERT_LEVEL_TEXT } from '#shared/alert-rules'
import type { ClientResponse } from '../utils/transport'
import { RULE_TEXT as SHARED_RULE_TEXT } from '#shared/alert-rules'

export type AlertLevelKey = 'REMIND' | 'YELLOW' | 'RED'

type RemindersResponse = ClientResponse<'/api/reminders', 'GET'>
export type ReminderItem = RemindersResponse['items'][number]

export const LEVEL_TEXT = SHARED_ALERT_LEVEL_TEXT
export const LEVEL_ORDER: AlertLevelKey[] = ['RED', 'YELLOW', 'REMIND']
/** 预警规则名称（唯一来源 shared/alert-rules.ts） */
export const RULE_TEXT = SHARED_RULE_TEXT

/** 每日汇总（置顶） */
export type DigestItem = NonNullable<RemindersResponse['digest']>

/** QMS 同步连续失败（只发给管理员，未读时置顶）；link 指向设置页"QMS 同步状态" */
export type PinnedItem = RemindersResponse['pinned'][number]

export function useReminders() {
  return useApiFetch<RemindersResponse>('/api/reminders', { key: 'reminders' })
}

/** 菜单"工作台"角标的未读数（前端改版第二轮）：独立的 key，不和首页的 reminders 冲突 */
export const UNREAD_KEY = 'reminder-unread'
export function useUnreadCount() {
  return useApiFetch<{ unread: number; planPending: number }>('/api/reminders/unread-count', { key: UNREAD_KEY, default: () => ({ unread: 0, planPending: 0 }) })
}

/** 提醒列表和角标一起刷新 */
export async function refreshReminders() {
  await refreshNuxtData(['reminders', UNREAD_KEY])
}

/** 汇总标为已读 */
export async function readDigest(d: DigestItem) {
  if (d.readAt) return
  await apiFetch(`/api/reminders/${d.id}/read`, { method: 'POST' }).catch(() => {})
  await refreshReminders()
}

/** 按红、黄、提醒分组，组内未读在前 */
export function groupReminders(items: ReminderItem[]) {
  return LEVEL_ORDER.map((level) => ({ level, items: items.filter((i) => i.level === level) })).filter((g) => g.items.length)
}

/** 标记已读（失败不打断跳转），并刷新列表 */
export async function readReminder(item: ReminderItem) {
  if (!item.readAt) {
    await apiFetch(`/api/reminders/${item.id}/read`, { method: 'POST' }).catch(() => {})
    await refreshReminders()
  }
}

export async function readAllReminders() {
  await apiFetch('/api/reminders/read-all', { method: 'POST' })
  await refreshReminders()
}
