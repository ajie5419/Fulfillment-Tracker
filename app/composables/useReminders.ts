import type { WorkBucket } from '#shared/workbench'
import { RULE_TEXT as SHARED_RULE_TEXT, type AlertRuleKey } from '#shared/alert-rules'

export type AlertLevelKey = 'REMIND' | 'YELLOW' | 'RED'

export interface ReminderItem {
  id: string
  title: string
  level: AlertLevelKey
  readAt: string | null
  createdAt: string
  alertId: string | null
  rule: AlertRuleKey | null
  /** 预警已消除（对象状态已变化） */
  cleared: boolean
  /** 已转为异常时的异常编号 */
  issueNo: string | null
  /** 电脑端跳转地址 */
  link: string | null
  /** 手机端跳转地址 */
  mobileLink: string | null
  /** 所属工单（工作台卡片，前端改版第二轮）；没有为 null */
  workOrderNumber?: string | null
  /** 对象的截止日 'YYYY-MM-DD'；没有为 null */
  dueDay?: string | null
  /** 工作台分组（服务端按工厂时区算） */
  bucket?: WorkBucket
}

export const LEVEL_TEXT = { RED: '红色', YELLOW: '黄色', REMIND: '提醒' } as const
export const LEVEL_COLOR = { RED: 'red', YELLOW: 'orange', REMIND: 'blue' } as const
export const LEVEL_ORDER: AlertLevelKey[] = ['RED', 'YELLOW', 'REMIND']
/** 预警规则名称（唯一来源 shared/alert-rules.ts） */
export const RULE_TEXT = SHARED_RULE_TEXT

/** 每日汇总（置顶） */
export interface DigestItem {
  id: string
  title: string
  level: AlertLevelKey
  readAt: string | null
  createdAt: string
  /** 前 5 项，一行一项 */
  lines: string[]
}

/** QMS 同步连续失败（只发给管理员，未读时置顶）；link 指向设置页"QMS 同步状态" */
export interface PinnedItem extends DigestItem {
  link: string
}

export function useReminders() {
  return useFetch<{ items: ReminderItem[]; unread: number; digest: DigestItem | null; pinned: PinnedItem[] }>('/api/reminders', { key: 'reminders' })
}

/** 菜单"工作台"角标的未读数（前端改版第二轮）：独立的 key，不和首页的 reminders 冲突 */
export const UNREAD_KEY = 'reminder-unread'
export function useUnreadCount() {
  return useFetch<{ unread: number; planPending: number }>('/api/reminders/unread-count', { key: UNREAD_KEY, default: () => ({ unread: 0, planPending: 0 }) })
}

/** 提醒列表和角标一起刷新 */
export async function refreshReminders() {
  await refreshNuxtData(['reminders', UNREAD_KEY])
}

/** 汇总标为已读 */
export async function readDigest(d: DigestItem) {
  if (d.readAt) return
  await $fetch(`/api/reminders/${d.id}/read`, { method: 'POST' }).catch(() => {})
  await refreshReminders()
}

/** 按红、黄、提醒分组，组内未读在前 */
export function groupReminders(items: ReminderItem[]) {
  return LEVEL_ORDER.map((level) => ({ level, items: items.filter((i) => i.level === level) })).filter((g) => g.items.length)
}

/** 标记已读（失败不打断跳转），并刷新列表 */
export async function readReminder(item: ReminderItem) {
  if (!item.readAt) {
    await $fetch(`/api/reminders/${item.id}/read`, { method: 'POST' }).catch(() => {})
    await refreshReminders()
  }
}

export async function readAllReminders() {
  await $fetch('/api/reminders/read-all', { method: 'POST' })
  await refreshReminders()
}
