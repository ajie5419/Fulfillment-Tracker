export type AlertLevelKey = 'REMIND' | 'YELLOW' | 'RED'

export interface ReminderItem {
  id: string
  title: string
  level: AlertLevelKey
  readAt: string | null
  createdAt: string
  alertId: string | null
  rule: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7' | 'W8' | null
  /** 预警已消除（对象状态已变化） */
  cleared: boolean
  /** 已转为异常时的异常编号 */
  issueNo: string | null
  /** 电脑端跳转地址 */
  link: string | null
  /** 手机端跳转地址 */
  mobileLink: string | null
}

export const LEVEL_TEXT = { RED: '红色', YELLOW: '黄色', REMIND: '提醒' } as const
export const LEVEL_COLOR = { RED: 'red', YELLOW: 'orange', REMIND: 'blue' } as const
export const LEVEL_ORDER: AlertLevelKey[] = ['RED', 'YELLOW', 'REMIND']
export const RULE_TEXT = { W1: 'W1 待确认匹配超时', W2: 'W2 转序停滞', W3: 'W3 外协逾期未返', W4: 'W4 异常超期', W5: 'W5 发放未签收 / 变更未确认', W6: 'W6 关键物料未到货', W7: 'W7 出图逾期', W8: 'W8 装配节点未齐套' } as const

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

/** 汇总标为已读 */
export async function readDigest(d: DigestItem) {
  if (d.readAt) return
  await $fetch(`/api/reminders/${d.id}/read`, { method: 'POST' }).catch(() => {})
  await refreshNuxtData('reminders')
}

/** 按红、黄、提醒分组，组内未读在前 */
export function groupReminders(items: ReminderItem[]) {
  return LEVEL_ORDER.map((level) => ({ level, items: items.filter((i) => i.level === level) })).filter((g) => g.items.length)
}

/** 标记已读（失败不打断跳转），并刷新列表 */
export async function readReminder(item: ReminderItem) {
  if (!item.readAt) {
    await $fetch(`/api/reminders/${item.id}/read`, { method: 'POST' }).catch(() => {})
    await refreshNuxtData('reminders')
  }
}

export async function readAllReminders() {
  await $fetch('/api/reminders/read-all', { method: 'POST' })
  await refreshNuxtData('reminders')
}
