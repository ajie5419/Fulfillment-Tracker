import type { PinnedItem, ReminderItem } from './useReminders'

/** Notification reading and business completion remain independent actions. */
export function useWorkbenchReminderActions() {
  /** 点一条：标记已读，跳到关联对象 */
  async function openReminder(item: ReminderItem) {
    await readReminder(item)
    if (item.link) await navigateTo(item.link)
  }
  /** 置顶的同步失败提醒：标为已读后去设置页看同步状态 */
  async function openPinned(p: PinnedItem) {
    await readDigest(p)
    await navigateTo(p.link)
  }
  async function readAll() {
    try {
      await readAllReminders()
    } catch (e) {
      message.error(apiError(e))
    }
  }

  return { openReminder, openPinned, readAll }
}
